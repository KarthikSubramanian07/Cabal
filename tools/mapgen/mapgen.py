#!/usr/bin/env python3
"""Generate the Cabal board (apps/web/src/map/board.json) from Natural Earth.

Natural Earth is public domain, so the board we ship is ours to license. The
pipeline:

1. Download Natural Earth 1:10m admin-1 regions (cached in ./cache).
2. Assign every region to a Diplomacy province (see provinces.py) and write GeoJSON.
3. mapshaper dissolves regions into provinces and simplifies with shared borders intact.
4. Project with a Lambert conformal conic centred on Europe and clip to the board frame.
5. Cut open water into sea zones along the hand placed boundary lines.
6. Compute anchors: unit, label, supply centre (at the real city), named coasts.
7. Check the drawn adjacency against the engine's border table and print differences.
8. Write board.json for the web client and build/preview.svg for eyeballing.

Usage:
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python mapgen.py
"""

from __future__ import annotations

import csv
import json
import math
import pathlib
import subprocess
import sys
import urllib.request
import zipfile
from collections import defaultdict

import numpy as np
import shapefile
import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import polylabel, split, unary_union

import provinces as P

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / "cache"
BUILD = HERE / "build"
OUT = ROOT / "apps" / "web" / "src" / "map" / "board.json"
BORDERS = ROOT / "crates" / "cabal-engine" / "data" / "borders.csv"
PROVINCES_CSV = ROOT / "crates" / "cabal-engine" / "data" / "provinces.csv"

NE_ADMIN1 = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"

WIDTH = 1200.0
# Lambert conformal conic
LAT1, LAT2, LAT0, LON0 = 40.0, 62.0, 50.0, 15.0


# ------------------------------------------------------------------ data ----

def fetch_admin1() -> pathlib.Path:
    CACHE.mkdir(exist_ok=True)
    zpath = CACHE / "ne_10m_admin_1_states_provinces.zip"
    target = CACHE / "ne_10m_admin_1_states_provinces"
    if not target.exists():
        if not zpath.exists():
            print("downloading Natural Earth admin-1 ...")
            req = urllib.request.Request(NE_ADMIN1, headers={"User-Agent": "cabal-mapgen"})
            with urllib.request.urlopen(req) as r, open(zpath, "wb") as f:
                f.write(r.read())
        with zipfile.ZipFile(zpath) as z:
            z.extractall(target)
    return target / "ne_10m_admin_1_states_provinces.shp"


def nearest_seed(pt: Point, candidates: list[str]) -> str:
    best, best_d = candidates[0], float("inf")
    coslat = math.cos(math.radians(pt.y))
    for code in candidates:
        for lon, lat in P.SEEDS.get(code, []):
            d = ((pt.x - lon) * coslat) ** 2 + (pt.y - lat) ** 2
            if d < best_d:
                best, best_d = code, d
    return best


def assign(rec: dict, geom) -> str | None:
    a3 = rec["adm0_a3"]
    if a3 in P.DROP_COUNTRIES:
        return None
    if a3 in P.COUNTRY_TO_PROVINCE:
        return P.COUNTRY_TO_PROVINCE[a3]
    names = P.NAME_TO_PROVINCE.get(a3, {})
    if rec["name"] in names:
        return names[rec["name"]]
    regions = P.REGION_TO_PROVINCE.get(a3, {})
    key = rec["geonunit"] if a3 == "GBR" else rec["region"]
    if key in regions:
        return regions[key]
    pt = geom.representative_point()
    if a3 == "PRT" and pt.x < -12:
        return None  # Azores, Madeira
    if a3 == "ESP" and rec["region"] == "Canary Is.":
        return None
    candidates = P.COUNTRY_CANDIDATES.get(a3)
    if not candidates:
        print(f"  warning: no rule for {a3} {rec['name']!r}, treating as impassable", file=sys.stderr)
        return "_ASI"
    return nearest_seed(pt, candidates)


def write_assigned(shp_path: pathlib.Path) -> pathlib.Path:
    BUILD.mkdir(exist_ok=True)
    out = BUILD / "admin.geojson"
    region = box(-45, 25, 70, 82)
    reader = shapefile.Reader(str(shp_path))
    features = []
    counts: dict[str, int] = defaultdict(int)
    for sr in reader.iterShapeRecords(fields=["adm0_a3", "name", "geonunit", "region"]):
        x0, y0, x1, y1 = sr.shape.bbox
        if x1 < -45 or x0 > 70 or y1 < 25 or y0 > 82:
            continue
        geom = shape(sr.shape.__geo_interface__)
        if not geom.is_valid:
            geom = shapely.make_valid(geom)
        rec = sr.record.as_dict()
        if rec["adm0_a3"] == "NOR":
            geom = geom.intersection(box(4, 55, 35, 72))  # mainland only: no Jan Mayen or Svalbard
        geom = geom.intersection(region)
        if geom.is_empty:
            continue
        code = assign(rec, geom)
        if code is None:
            continue
        counts[code] += 1
        features.append({"type": "Feature", "properties": {"code": code}, "geometry": mapping(geom)})
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"assigned {len(features)} regions to {len(counts)} provinces")
    return out


def dissolve(src: pathlib.Path) -> pathlib.Path:
    dst = BUILD / "provinces.geojson"
    cmd = [
        "npx", "-y", "mapshaper@0.7.61",
        "-i", str(src), "snap",
        "-dissolve2", "code",
        "-simplify", "interval=1800", "keep-shapes",
        "-filter-islands", "min-area=300km2", "remove-empty",
        "-o", str(dst), "format=geojson", "precision=0.0001", "force",
    ]
    print("mapshaper:", " ".join(cmd[3:]))
    subprocess.run(cmd, check=True, cwd=HERE)
    return dst


# ------------------------------------------------------------ projection ----

def lcc_factory():
    p1, p2, p0 = map(math.radians, (LAT1, LAT2, LAT0))
    n = math.log(math.cos(p1) / math.cos(p2)) / math.log(
        math.tan(math.pi / 4 + p2 / 2) / math.tan(math.pi / 4 + p1 / 2)
    )
    F = math.cos(p1) * math.tan(math.pi / 4 + p1 / 2) ** n / n
    rho0 = F / math.tan(math.pi / 4 + p0 / 2) ** n
    lam0 = math.radians(LON0)

    def project(coords: np.ndarray) -> np.ndarray:
        lon = np.radians(coords[:, 0])
        lat = np.radians(np.clip(coords[:, 1], -89.0, 89.0))
        rho = F / np.tan(np.pi / 4 + lat / 2) ** n
        theta = n * (lon - lam0)
        return np.column_stack([rho * np.sin(theta), rho0 - rho * np.cos(theta)])

    return project


class Frame:
    """Projected board frame mapped to SVG units (y down)."""

    def __init__(self, project):
        self.project = project
        pts = lambda ll: project(np.array(ll, dtype=float))  # noqa: E731
        xs = pts([(-17.0, 50.0)])[:, 0]
        xe = pts([(46.0, 44.0)])[:, 0]
        yt = pts([(15.0, 72.2)])[:, 1]
        yb = pts([(15.0, 32.4)])[:, 1]
        self.x0, self.x1 = float(xs[0]), float(xe[0])
        self.ytop, self.ybot = float(yt[0]), float(yb[0])
        self.scale = WIDTH / (self.x1 - self.x0)
        self.height = round((self.ytop - self.ybot) * self.scale, 1)

    def to_svg(self, coords: np.ndarray) -> np.ndarray:
        xy = self.project(coords)
        return np.column_stack([(xy[:, 0] - self.x0) * self.scale, (self.ytop - xy[:, 1]) * self.scale])

    def geom(self, g):
        return shapely.transform(g, self.to_svg)

    def point(self, lon: float, lat: float) -> Point:
        x, y = self.to_svg(np.array([[lon, lat]]))[0]
        return Point(float(x), float(y))

    @property
    def rect(self):
        return box(0, 0, WIDTH, self.height)


# ------------------------------------------------------------------ seas ----

def cut_seas(frame: Frame, land):
    water = frame.rect.difference(land)
    lines = []
    shared = [pt for poly in P.SEA_BOUNDARIES for pt in poly]
    for poly in P.SEA_BOUNDARIES:
        for lon, lat in (poly[0], poly[-1]):
            if shared.count((lon, lat)) > 1:
                continue  # a junction where boundary lines meet
            pt = frame.point(lon, lat)
            if frame.rect.contains(pt) and not land.buffer(0.5).contains(pt):
                print(f"  boundary endpoint in water: ({lon}, {lat})")
        coords = frame.to_svg(np.array(poly, dtype=float))
        # extend both ends a little so the cut always reaches the shore
        a, b = coords[0], coords[1]
        c, d = coords[-2], coords[-1]
        ext = lambda p, q: p + (p - q) / (np.linalg.norm(p - q) + 1e-9) * 4.0  # noqa: E731
        coords = np.vstack([ext(a, b), coords, ext(d, c)])
        lines.append(LineString(coords))
    pieces = list(split(water, MultiLineString(lines)).geoms)

    seeds = []
    for code, pts in P.SEA_SEEDS.items():
        seeds += [(code, frame.point(lon, lat)) for lon, lat in pts]
    seeds += [("_LAKE", frame.point(lon, lat)) for lon, lat in P.LAKE_SEEDS]

    labels: list[str | None] = []
    problems = []
    for piece in pieces:
        found = {code for code, pt in seeds if piece.contains(pt)}
        if len(found) > 1:
            problems.append(f"one water piece holds seeds {sorted(found)}")
        labels.append(sorted(found)[0] if found else None)

    # unlabeled pieces join the labeled neighbour they share the longest border with
    changed = True
    while changed:
        changed = False
        for i, piece in enumerate(pieces):
            if labels[i] is not None:
                continue
            best, best_len = None, 0.0
            for j, other in enumerate(pieces):
                if labels[j] is None or labels[j] == "_LAKE" or i == j:
                    continue
                shared = piece.boundary.intersection(other.buffer(0.3)).length
                if shared > best_len:
                    best, best_len = labels[j], shared
            if best is not None and best_len > 0.5:
                labels[i] = best
                changed = True

    seas: dict[str, list] = defaultdict(list)
    lakes = []
    for piece, label in zip(pieces, labels):
        if label is None or label == "_LAKE":
            lakes.append(piece)
        else:
            seas[label].append(piece)
    missing = sorted(set(P.SEA_SEEDS) - set(seas))
    if missing:
        problems.append(f"sea zones without water: {missing}")
    return {code: unary_union(parts) for code, parts in seas.items()}, lakes, problems


# --------------------------------------------------------------- anchors ----

def main_part(g):
    if isinstance(g, MultiPolygon):
        return max(g.geoms, key=lambda p: p.area)
    return g


def inside_point(poly, near: Point, min_clear: float) -> Point:
    """A point inside `poly`, at least `min_clear` from its edge when possible, close to `near`."""
    for clear in (min_clear, min_clear / 2, 1.0):
        inner = poly.buffer(-clear)
        if not inner.is_empty:
            if inner.contains(near):
                return near
            return shapely.ops.nearest_points(inner, near)[0]
    return near


def anchors(frame: Frame, geoms: dict, kinds: dict):
    result = {}
    for code, g in geoms.items():
        body = main_part(g)
        center = polylabel(body, tolerance=0.5)
        entry = {"label": [round(center.x, 1), round(center.y, 1)]}
        unit = center
        if code in P.SUPPLY_CENTERS:
            sc = inside_point(body, frame.point(*P.SUPPLY_CENTERS[code]), 5.0)
            entry["sc"] = [round(sc.x, 1), round(sc.y, 1)]
            if unit.distance(sc) < 16:
                # push the unit away from the centre dot along the dot -> centre direction
                dx, dy = center.x - sc.x, center.y - sc.y
                norm = math.hypot(dx, dy) or 1.0
                target = Point(sc.x + dx / norm * 18, sc.y + dy / norm * 18)
                unit = inside_point(body, target, 7.0)
        entry["unit"] = [round(unit.x, 1), round(unit.y, 1)]
        # the label sits under the unit when there is room
        below = Point(unit.x, unit.y + 15)
        if kinds.get(code) != "sea" and body.buffer(-3).contains(below):
            entry["label"] = [round(below.x, 1), round(below.y, 1)]
        result[code] = entry
    return result


def coast_anchors(geoms: dict, seas: dict, anchor: dict, problems: list):
    out = {}
    for code, coasts in P.COAST_FACING.items():
        if code not in geoms or any(sea not in seas for sea in coasts.values()):
            problems.append(f"cannot place coasts of {code}")
            continue
        body = main_part(geoms[code])
        center = Point(anchor[code]["label"])
        out[code] = {}
        for coast, sea in coasts.items():
            shore = body.boundary.intersection(seas[sea].buffer(1.5))
            parts = list(getattr(shore, "geoms", [shore]))
            parts = [p for p in parts if p.length > 0]
            if not parts:
                raise SystemExit(f"{code} {coast}: no shoreline shared with {sea}")
            if code == "SPA" and coast == "NC":
                piece = min(parts, key=lambda p: p.centroid.y)  # Bay of Biscay, not Cadiz
            else:
                piece = max(parts, key=lambda p: p.length)
            mid = piece.interpolate(0.5, normalized=True)
            dx, dy = center.x - mid.x, center.y - mid.y
            norm = math.hypot(dx, dy) or 1.0
            pt = inside_point(body, Point(mid.x + dx / norm * 11, mid.y + dy / norm * 11), 4.0)
            out[code][coast] = [round(pt.x, 1), round(pt.y, 1)]
    return out


# ------------------------------------------------------------ validation ----

def engine_adjacency():
    army, fleet = set(), set()
    with open(BORDERS) as f:
        rows = list(csv.reader(f))[1:]
    for a, b, terrain in rows:
        pa, pb = a.strip()[:3].upper(), b.strip()[:3].upper()
        pair = tuple(sorted((pa, pb)))
        if terrain.strip() in ("land", "coast"):
            army.add(pair)
        if terrain.strip() in ("sea", "coast"):
            fleet.add(pair)
    return army, fleet


SEA_CODES = set(P.SEA_SEEDS)


def drawn_adjacency(geoms: dict):
    codes = sorted(geoms)
    pairs = set()
    tree = shapely.STRtree([geoms[c] for c in codes])
    for i, c in enumerate(codes):
        for j in tree.query(geoms[c].buffer(1.0)):
            if j <= i:
                continue
            d = codes[j]
            shared = geoms[c].boundary.intersection(geoms[d].buffer(0.8))
            both_sea = c in SEA_CODES and d in SEA_CODES
            if shared.length > (8.0 if both_sea else 2.0):
                pairs.add((c, d))
    return pairs


# ------------------------------------------------------------------ output ----

def path_d(g) -> str:
    parts = []
    polys = g.geoms if isinstance(g, MultiPolygon) else [g]
    for poly in polys:
        if poly.is_empty or not isinstance(poly, Polygon):
            continue
        for ring in [poly.exterior, *poly.interiors]:
            pts = np.round(np.asarray(ring.coords)[:-1], 1)
            if len(pts) < 3:
                continue
            seg = [f"M{pts[0][0]:g} {pts[0][1]:g}"]
            prev = pts[0]
            for p in pts[1:]:
                dx, dy = round(p[0] - prev[0], 1), round(p[1] - prev[1], 1)
                if dx == 0 and dy == 0:
                    continue
                seg.append(f"l{dx:g} {dy:g}")
                prev = np.array([prev[0] + dx, prev[1] + dy])
            parts.append("".join(seg) + "z")
    return "".join(parts)


def line_d(g) -> str:
    parts = []
    lines = getattr(g, "geoms", [g])
    for line in lines:
        if line.is_empty or line.geom_type not in ("LineString", "LinearRing"):
            continue
        pts = np.round(np.asarray(line.coords), 1)
        if len(pts) < 2:
            continue
        seg = [f"M{pts[0][0]:g} {pts[0][1]:g}"]
        prev = pts[0]
        for p in pts[1:]:
            dx, dy = round(p[0] - prev[0], 1), round(p[1] - prev[1], 1)
            if dx == 0 and dy == 0:
                continue
            seg.append(f"l{dx:g} {dy:g}")
            prev = np.array([prev[0] + dx, prev[1] + dy])
        if len(seg) > 1:
            parts.append("".join(seg))
    return "".join(parts)


def flatten_lines(g):
    out = []
    for part in getattr(g, "geoms", [g]):
        if part.geom_type in ("LineString", "LinearRing"):
            out.append(part)
        elif hasattr(part, "geoms"):
            out.extend(flatten_lines(part))
    return shapely.ops.linemerge(out) if out else g


def polygons_only(g):
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    polys = [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    return MultiPolygon(polys) if polys else Polygon()


def main() -> int:
    shp = fetch_admin1()
    assigned = write_assigned(shp)
    dissolved = dissolve(assigned)

    project = lcc_factory()
    frame = Frame(project)
    print(f"frame {WIDTH:g} x {frame.height:g}")

    with open(PROVINCES_CSV) as f:
        terrain = {row[0].upper(): row for row in csv.reader(f)}
    with open(ROOT / "crates" / "cabal-engine" / "data" / "regions.csv") as f:
        kinds = {}
        for prov, coast, t in list(csv.reader(f))[1:]:
            if not coast:
                kinds[prov.upper()] = t
    kinds["SWI"] = "impassable"

    fc = json.loads(dissolved.read_text())
    land: dict[str, object] = {}
    for feat in fc["features"]:
        code = feat["properties"]["code"]
        g = frame.geom(shape(feat["geometry"])).buffer(0).intersection(frame.rect)
        g = polygons_only(g)
        if not g.is_empty:
            land[code] = unary_union([land[code], g]) if code in land else g
    all_land = unary_union(list(land.values()))
    seas, lakes, problems = cut_seas(frame, all_land)

    provinces = {c: g for c, g in land.items() if not c.startswith("_")}
    impassable = [g for c, g in land.items() if c.startswith("_")]
    geoms = {**provinces, **seas}
    expected = set(terrain) - {"SHORT_NAME"}
    missing = sorted(expected - set(geoms))
    extra = sorted(set(geoms) - expected)
    if missing or extra:
        problems.append(f"missing provinces {missing}, unexpected {extra}")

    anchor = anchors(frame, geoms, kinds)
    coasts = coast_anchors(geoms, seas, anchor, problems)

    army, fleet = engine_adjacency()
    drawn = drawn_adjacency(geoms)
    land_codes = {c for c in provinces if kinds.get(c) != "impassable"}
    sea_codes = set(seas)
    touching_not_rules = sorted(
        p for p in drawn
        if not (p in army or p in fleet) and "SWI" not in p
    )
    rules_not_touching = sorted(
        p for p in (army | fleet)
        if p not in drawn and (p[0] in geoms and p[1] in geoms)
    )

    edge = frame.rect.exterior.buffer(0.8)
    coast = flatten_lines(all_land.boundary.difference(edge))
    sea_lines = flatten_lines(
        unary_union([g.boundary for g in seas.values()]).difference(all_land.buffer(0.8)).difference(edge)
    )
    with open(PROVINCES_CSV) as f:
        names = {row[0].upper(): row[1] for row in list(csv.reader(f))[1:]}

    board = {
        "source": "Generated by tools/mapgen from Natural Earth (public domain). See tools/mapgen/README.md.",
        "width": WIDTH,
        "height": frame.height,
        "coast": line_d(coast),
        "seaLines": line_d(sea_lines),
        "provinces": {},
        "impassable": [path_d(g) for g in impassable],
        "lakes": [path_d(g) for g in lakes if g.area > 4],
    }
    for code in sorted(geoms):
        kind = "sea" if code in sea_codes else kinds.get(code, "land")
        entry = {"name": names.get(code, code), "kind": kind, "d": path_d(geoms[code]), **anchor[code]}
        if code in coasts:
            entry["coasts"] = coasts[code]
        board["provinces"][code] = entry
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(board, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")

    write_preview(board)

    print(f"\nadjacent in the rules but not touching on the map ({len(rules_not_touching)}):")
    print("  " + ", ".join("-".join(p) for p in rules_not_touching))
    print(f"touching on the map but not adjacent in the rules ({len(touching_not_rules)}):")
    print("  " + ", ".join("-".join(p) for p in touching_not_rules))
    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


def write_preview(board: dict) -> None:
    w, h = board["width"], board["height"]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">',
           '<rect width="100%" height="100%" fill="#bcd3dd"/>']
    for d in board["impassable"]:
        out.append(f'<path d="{d}" fill="#c9c2b2" stroke="#3b3733" stroke-width="0.6"/>')
    for d in board["lakes"]:
        out.append(f'<path d="{d}" fill="#bcd3dd" stroke="#3b3733" stroke-width="0.4"/>')
    for code, p in board["provinces"].items():
        fill = {"sea": "#cfdde5", "impassable": "#8a857c"}.get(p["kind"], "#f1ead9")
        out.append(f'<path d="{p["d"]}" fill="{fill}" stroke="#3b3733" stroke-width="0.7"/>')
    for code, p in board["provinces"].items():
        x, y = p["label"]
        out.append(f'<text x="{x}" y="{y}" font-size="9" text-anchor="middle" font-family="monospace">{code}</text>')
        if "sc" in p:
            out.append(f'<circle cx="{p["sc"][0]}" cy="{p["sc"][1]}" r="3.5" fill="#fff" stroke="#000"/>')
        ux, uy = p["unit"]
        out.append(f'<circle cx="{ux}" cy="{uy}" r="2" fill="#d94f30"/>')
        for c, (cx, cy) in p.get("coasts", {}).items():
            out.append(f'<text x="{cx}" y="{cy}" font-size="7" fill="#1d4e89" text-anchor="middle">{c}</text>')
    out.append("</svg>")
    (BUILD / "preview.svg").write_text("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
