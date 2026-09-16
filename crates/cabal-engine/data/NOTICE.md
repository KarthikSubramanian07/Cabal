# Data attribution

`provinces.csv` and `regions.csv` describe the classic 1901 Diplomacy map (75 playable provinces plus
impassable Switzerland, 81 regions). They are derived from
[TedDriggs/diplomacy](https://github.com/TedDriggs/diplomacy) (MIT License, Copyright (c) 2025 Ted Driggs)
and used here under the same license. `borders.csv` (218 borders) was regenerated from the adjacency
facts of the standard map as encoded by zond/godip and cross-checked against the MILA `standard.map`;
the upstream table was missing nine edges (for example Gulf of Bothnia to St Petersburg south coast).

`../tests/data/datc_v3.json` encodes the Diplomacy Adjudicator Test Cases v3.0 by Lucas B. Kruijswijk,
in the JSON layout of the same project, with expectations corrected to the DATC's stated preferences
where the upstream file marked cases as ignored or errata (6.B.7, 6.B.8, 6.B.10, 6.B.12, 6.B.15,
6.G.19, 6.H.1, 6.H.2, 6.H.3). The DATC itself: https://webdiplomacy.net/doc/DATC_v3_0.html
