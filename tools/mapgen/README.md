# mapgen: the Cabal board, drawn from real geography

`mapgen.py` builds `apps/web/src/map/board.json`, the classic 1901 Diplomacy board the web client renders. It is generated from [Natural Earth](https://www.naturalearthdata.com/) admin-1 regions, which are in the public domain, so the board is ours to ship under the MIT license with no attribution strings attached.

Existing open maps were ruled out for licensing. The Wikimedia board is CC BY-SA, the Diplicity and MILA boards are GPL, and several others have no license at all.

## Run it

```sh
cd tools/mapgen
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python mapgen.py
```

It needs Node for `npx mapshaper`. The Natural Earth download (15 MB) is cached in `cache/`, and intermediate files and `build/preview.svg` go to `build/`. Both folders are gitignored.

## How it works

```mermaid
flowchart LR
  NE[Natural Earth admin-1] --> A[assign each region to a province]
  A --> M[mapshaper: dissolve and simplify with shared borders]
  M --> PR[Lambert conformal conic, clip to the board frame]
  PR --> S[cut open water into sea zones]
  S --> AN[anchors: units, labels, supply centres, coasts]
  AN --> V[check adjacency against the engine]
  V --> J[board.json]
```

1. **Assignment** (`provinces.py`). Whole countries map to one province (Hungary is Budapest). Historic borders use explicit tables (German Länder, Austrian states, Russian oblasts, Italian regions). Everything else joins the nearest seed city among the provinces its country may belong to, which is how France's departments become Brest, Picardy, Paris, Burgundy, Gascony and Marseilles.
2. **Dissolve and simplify.** mapshaper merges regions into provinces and simplifies at a 1.8 km interval while keeping shared borders identical, so neighbouring provinces never gap or overlap.
3. **Projection.** A Lambert conformal conic (standard parallels 40°N and 62°N, centred on 15°E) framed from the Atlantic to the Caspian and from the Barents Sea to North Africa.
4. **Seas.** Open water is split along the straight lines in `SEA_BOUNDARIES`, the way the printed board draws them. Each piece is named by the seed it contains. The Sea of Marmara and the Caspian are drawn as water that belongs to no zone.
5. **Anchors.** Unit and label positions come from the pole of inaccessibility of each province. Supply centres sit on their real cities. The six named coasts are placed on the shoreline they face.
6. **Validation.** Drawn adjacency is compared with `crates/cabal-engine/data/borders.csv`. The expected differences are straits, where the rules connect provinces across water: Denmark to Sweden, the Mid-Atlantic to the Western Mediterranean at Gibraltar, and the Baltic to the Skagerrak at the Great Belt.

The engine's border table stays the source of truth for the rules. The map only has to look right.

## Output format

```jsonc
{
  "width": 1200, "height": 1169.4,
  "coast": "M.. l..",          // every shoreline, for a heavier stroke
  "seaLines": "M.. l..",       // boundaries between sea zones
  "impassable": ["M..z"],      // Ireland, Iceland, the Mediterranean islands, board edges
  "lakes": ["M..z"],           // Sea of Marmara, Caspian
  "provinces": {
    "PAR": { "name": "Paris", "kind": "land", "d": "M..z",
             "unit": [x, y], "label": [x, y], "sc": [x, y] },
    "STP": { "kind": "coast", "coasts": { "NC": [x, y], "SC": [x, y] } }
  }
}
```
