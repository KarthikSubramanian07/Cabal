#!/usr/bin/env python3
"""Read-only provenance audit against the independent checkout in GODIP_REF.

This checks transcriptions, not adjudication. It never invokes Cabal to generate
expectations, and never writes to the upstream checkout or the corpus.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(os.environ["GODIP_REF"])
corpus = json.loads((Path(__file__).resolve().parents[1] /
                     "crates/cabal-engine/tests/data/oracle_godip.json").read_text())
commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
assert commit == corpus["godip_commit"]
found = {}
for filename in ("dipai.txt", "real.txt", "droidippy_errors.txt", "diplicity_errors.txt"):
    path = root / "variants/classical/datc" / filename
    for block in re.split(r"^CASE ", path.read_text(), flags=re.M)[1:]:
        lines = block.splitlines()
        name = lines[0]
        sections = {}
        section = None
        phase = None
        for raw in lines[1:]:
            line = raw.split("#")[0].strip()
            if not line:
                continue
            if line == "END":
                break
            if line.startswith("PRESTATE_SETPHASE"):
                phase = line.removeprefix("PRESTATE_SETPHASE").strip()
            elif line in ("PRESTATE", "ORDERS", "POSTSTATE", "PRESTATE_DISLODGED",
                          "POSTSTATE_DISLODGED", "PRESTATE_SUPPLYCENTER_OWNERS", "PRESTATE_RESULTS"):
                section = line
                sections[section] = []
            elif section:
                sections[section].append(line)
        found[name] = (path, phase, sections)
assert len(found) == 18
production = [c for c in corpus["cases"] if c["source_file"].startswith("variants/")]
assert {c["source_case"] for c in production} == set(found)
for case in production:
    path, phase, sections = found[case["source_case"]]
    assert case["source_file"] == str(path.relative_to(root))
    assert case["godip_commit"] == commit
    assert case["source_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert case["phase"] == phase
    for field, section in (("starting_units", "PRESTATE"), ("starting_dislodged", "PRESTATE_DISLODGED"),
                           ("orders", "ORDERS"), ("expected_units", "POSTSTATE"),
                           ("starting_results", "PRESTATE_RESULTS"),
                           ("upstream_poststate_dislodged", "POSTSTATE_DISLODGED")):
        assert case[field] == sections.get(section, []), (case["name"], field)
    owners = {u.split()[-1]: u.split(":")[0] for u in sections.get("PRESTATE_SUPPLYCENTER_OWNERS", [])}
    assert case["starting_owners"] == owners
    assert case["expected_owners"] == owners
print(f"Verified all {len(production)} production transcriptions against godip {commit}")
