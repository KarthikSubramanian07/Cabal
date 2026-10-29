#!/usr/bin/env python3
"""Fail when opening adjudication is more than 30% slower than its baseline.

CI benchmarks the base commit and the change on the same runner, saving the
base run as the Criterion baseline named `before`, and passes `--against before`.
Shared runners differ by far more than 30% from one another, so only a
same-machine comparison is a reliable gate. Without a same-machine baseline
(a local run, or a base commit that predates the bench) the committed
`crates/cabal-engine/benches/baseline.json` is used instead.
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECORDED = ROOT / "crates/cabal-engine/benches/baseline.json"
LIMIT = 1.30


def mean(path: Path) -> float:
    return json.loads(path.read_text())["mean"]["point_estimate"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--against", help="Criterion baseline name measured on this machine")
    args = parser.parse_args()

    recorded = json.loads(RECORDED.read_text())
    home = Path(os.environ.get("CRITERION_HOME", ROOT / "target/criterion"))
    bench = home / recorded["benchmark"]
    current_path = bench / "new/estimates.json"
    if not current_path.exists():
        print(f"Criterion result missing: {current_path}", file=sys.stderr)
        return 1
    current = mean(current_path)

    base_path = bench / args.against / "estimates.json" if args.against else None
    if base_path and base_path.exists():
        baseline, source = mean(base_path), f"base commit on this runner ({args.against})"
    else:
        if args.against:
            print(f"no '{args.against}' baseline at {base_path}; using the recorded one")
        baseline, source = recorded["estimate"], f"recorded baseline ({recorded['recorded_with']})"

    change = (current / baseline - 1) * 100
    print(
        f"{recorded['benchmark']}: {current:,.0f} ns against {baseline:,.0f} ns "
        f"from the {source}: {change:+.1f}% (limit +{(LIMIT - 1) * 100:.0f}%)"
    )
    if current > baseline * LIMIT:
        print("Opening adjudication regressed by more than 30%.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
