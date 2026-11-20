/**
 * The board, composed from the two documents that describe it:
 *
 * - the variant: the engine's own map document (`crates/cabal-engine/data/maps/<name>.json`,
 *   the format of issue #7), which says which provinces exist, what each is called, its
 *   terrain, which hold supply centres and which have named coasts;
 * - the geometry: `board.json`, drawn by tools/mapgen, which says only where things are (each
 *   province's outline, where its piece stands and its code is written, where its centre and
 *   coasts sit) and draws the coastline, sea lanes, lakes and land outside every province.
 *
 * `composeBoard` joins them and refuses a pair that does not fit, so a variant whose provinces
 * the geometry does not draw fails loudly instead of rendering a board with holes in it.
 *
 * Only erasable TypeScript and type imports here: the asset scripts under scripts/ import this
 * file straight into Node.
 */
import type { Board, BoardProvince, Point } from "./boardData.js";

/** A variant map document. Only what the board reads is typed. */
export interface VariantDocument {
  name: string;
  provinces: readonly { name: string; full_name: string; supply_center: string | null }[];
  regions: readonly { province: string; coast?: string | null | undefined; terrain: string }[];
  borders: readonly { from: string; to: string }[];
}

/** One province as the geometry draws it. */
export interface ProvinceGeometry {
  /** SVG path in board units. */
  d: string;
  /** Where a unit stands. */
  unit: Point;
  /** Where the province code is written. */
  label: Point;
  /** Where the supply centre marker goes (the real city), for a province that has one. */
  sc?: Point;
  /** Fleet positions on named coasts (`NC`, `SC`, `EC`). */
  coasts?: Record<string, Point>;
}

/** board.json: where everything on a variant's board is drawn. */
export interface BoardGeometry {
  /** The variant this geometry draws. */
  variant: string;
  width: number;
  height: number;
  coast: string;
  seaLines: string;
  impassable: string[];
  lakes: string[];
  provinces: Record<string, ProvinceGeometry>;
}

/** The variant and the geometry disagree; `problems` says how, one line each. */
export class BoardMismatch extends Error {
  readonly problems: readonly string[];
  constructor(variant: string, problems: readonly string[]) {
    super(`The board geometry does not fit the ${variant} map: ${problems.join("; ")}.`);
    this.name = "BoardMismatch";
    this.problems = problems;
  }
}

/** A variant names a province `stp` and a coast `n`; the board writes `STP` and `NC`. */
const provinceCode = (name: string) => name.split("(")[0]!.toUpperCase();
const coastCode = (coast: string) => (coast.length === 1 ? `${coast}c` : coast).toUpperCase();

/**
 * The board to draw for `variant`, with `geometry` saying where. Each province's name, kind,
 * supply centre and named coasts come from the variant. A province no border reaches (the
 * standard map's Switzerland) is impassable. Throws a `BoardMismatch` when the geometry misses
 * a province, a centre or a coast the variant has, or draws one it does not.
 */
export function composeBoard(variant: VariantDocument, geometry: BoardGeometry): Board {
  const problems: string[] = [];
  if (geometry.variant !== variant.name) problems.push(`it draws the ${geometry.variant} map`);

  const terrain = new Map<string, string>();
  const coasts = new Map<string, Set<string>>();
  for (const r of variant.regions) {
    const code = provinceCode(r.province);
    if (r.coast) {
      const set = coasts.get(code) ?? new Set<string>();
      set.add(coastCode(r.coast));
      coasts.set(code, set);
    } else {
      terrain.set(code, r.terrain);
    }
  }
  const reached = new Set<string>();
  for (const b of variant.borders) {
    reached.add(provinceCode(b.from));
    reached.add(provinceCode(b.to));
  }

  const provinces: Record<string, BoardProvince> = {};
  const known = new Set<string>();
  for (const p of variant.provinces) {
    const code = provinceCode(p.name);
    known.add(code);
    const drawn = geometry.provinces[code];
    if (!drawn) {
      problems.push(`no outline for ${code}`);
      continue;
    }
    const kind = !reached.has(code) ? "impassable" : (terrain.get(code) ?? "land");
    if (kind !== "land" && kind !== "coast" && kind !== "sea" && kind !== "impassable") {
      problems.push(`${code} has an unknown terrain, ${kind}`);
      continue;
    }
    const province: BoardProvince = { name: p.full_name, kind, d: drawn.d, unit: drawn.unit, label: drawn.label };
    if (p.supply_center) {
      if (drawn.sc) province.sc = drawn.sc;
      else problems.push(`no supply centre marker for ${code}`);
    } else if (drawn.sc) {
      problems.push(`a supply centre marker for ${code}, which has no centre`);
    }
    const named = [...(coasts.get(code) ?? [])].sort();
    if (named.length > 0) {
      const at: Record<string, Point> = {};
      for (const c of named) {
        const point = drawn.coasts?.[c];
        if (point) at[c] = point;
        else problems.push(`no position for the fleet on ${code}/${c}`);
      }
      province.coasts = at;
    }
    for (const c of Object.keys(drawn.coasts ?? {})) {
      if (!named.includes(c)) problems.push(`a coast ${code}/${c} the map does not have`);
    }
    provinces[code] = province;
  }
  for (const code of Object.keys(geometry.provinces)) {
    if (!known.has(code)) problems.push(`an outline for ${code}, which the map does not have`);
  }
  if (problems.length > 0) throw new BoardMismatch(variant.name, problems);

  // In code order, whatever order the variant lists them in: the board draws them in this order.
  const sorted: Record<string, BoardProvince> = {};
  for (const code of Object.keys(provinces).sort()) sorted[code] = provinces[code]!;
  const { width, height, coast, seaLines, impassable, lakes } = geometry;
  return { width, height, coast, seaLines, impassable, lakes, provinces: sorted };
}
