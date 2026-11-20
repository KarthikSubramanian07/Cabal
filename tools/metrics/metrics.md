# Phase 1 metrics

Written by `tools/metrics`; see its README for the command behind each line.

| Metric | Target | Value | Where | Date | Commit | Result |
|---|---|---|---|---|---|---|
| DATC v3.0 | 100 percent, zero skipped | 171 of 171 passed, 0 failed, 0 skipped | local (cargo) | 2026-11-20 | `2b4ff1396e59` | pass |
| Full 7 seat game | finishes with no manual intervention | finished: draw by vote after 16 phases, 2.5 s, 2 people and 5 bots | local (wrangler dev) | 2026-11-20 | `2b4ff1396e59` | pass |
| Landing page to a game in progress | under 60 s, AI seats filling the table | 1.8 s | local (wrangler dev), desktop | 2026-11-20 | `2b4ff1396e59` | pass |
| Landing page to a game in progress | under 60 s, AI seats filling the table | 2.0 s | local (wrangler dev), phone | 2026-11-20 | `2b4ff1396e59` | pass |
| Order submit round trip | p95 under 150 ms (Europe or North America) | p95 39.9 ms (p50 7, p99 111.3, n 100) | local (wrangler dev) | 2026-11-20 | `2b4ff1396e59` | pass |
