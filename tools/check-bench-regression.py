#!/usr/bin/env python3
"""Fail when a gated engine benchmark is more than 30% slower than its baseline.

Gated: opening adjudication, and legal order enumeration on the fleet-heavy
midgame board, both one power at a time and with the shared convoy search. The
list lives in `crates/cabal-engine/benches/baseline.json`.

CI benchmarks the base commit and the change on the same runner, saving the
base run as the Criterion baseline named `before`, and passes `--against before`.
Shared runners differ by far more than 30% from one another, so only a
same-machine comparison is a reliable gate. A benchmark the base commit does
not have yet (it was added by the change) is reported and skipped. Without
`--against` (a local run) the numbers recorded in `baseline.json` are used.
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


def gated(recorded: dict) -> dict:
    """Benchmark name to recorded estimate; reads the single-benchmark layout too."""
    if "benchmarks" in recorded:
        return recorded["benchmarks"]
    return {recorded["benchmark"]: recorded["estimate"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--against", help="Criterion baseline name measured on this machine")
    args = parser.parse_args()

    recorded = json.loads(RECORDED.read_text())
    home = Path(os.environ.get("CRITERION_HOME", ROOT / "target/criterion"))
    failed = []
    compared = 0
    for name, estimate in gated(recorded).items():
        bench = home / name
        current_path = bench / "new/estimates.json"
        if not current_path.exists():
            print(f"{name}: Criterion result missing at {current_path}", file=sys.stderr)
            failed.append(name)
            continue
        current = mean(current_path)

        if args.against:
            base_path = bench / args.against / "estimates.json"
            if not base_path.exists():
                print(f"{name}: {current:,.0f} ns; the base commit has no such benchmark, not gated")
                continue
            baseline, source = mean(base_path), f"base commit on this runner ({args.against})"
        else:
            baseline, source = estimate, f"recorded baseline ({recorded['recorded_with']})"

        compared += 1
        change = (current / baseline - 1) * 100
        print(
            f"{name}: {current:,.0f} ns against {baseline:,.0f} ns "
            f"from the {source}: {change:+.1f}% (limit +{(LIMIT - 1) * 100:.0f}%)"
        )
        if current > baseline * LIMIT:
            failed.append(name)

    if failed:
        print(f"Regressed by more than 30% or missing: {', '.join(failed)}", file=sys.stderr)
        return 1
    if compared == 0:
        print("no benchmark could be compared", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
