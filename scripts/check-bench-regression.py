#!/usr/bin/env python3
"""Fail when opening adjudication is more than 30% slower than its baseline."""

import json
import sys
from pathlib import Path


root = Path(__file__).resolve().parents[1]
baseline_path = root / "crates/cabal-engine/benches/baseline.json"
baseline = json.loads(baseline_path.read_text())
estimate_path = (
    root
    / "target/criterion"
    / baseline["benchmark"]
    / "new/estimates.json"
)
if not estimate_path.exists():
    sys.exit(f"Criterion result missing: {estimate_path}")

measured = json.loads(estimate_path.read_text())[baseline["statistic"]][
    "point_estimate"
]
limit = baseline["estimate"] * 1.30
change = (measured / baseline["estimate"] - 1) * 100
print(
    f"{baseline['benchmark']}: baseline {baseline['estimate']:.1f} ns, "
    f"current {measured:.1f} ns ({change:+.1f}%), limit {limit:.1f} ns"
)
if measured > limit:
    sys.exit("Opening adjudication regressed by more than 30%.")
