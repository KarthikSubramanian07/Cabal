import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { datcLine } from "../datc.mjs";
import { METRICS, line, readReport, record, renderTable, upsert } from "./report.mjs";

const fixed = { date: "2026-11-19", commit: "abc123def456" };

describe("the metrics report", () => {
  it("keeps one line per metric and place, newest wins, in the plan's order", () => {
    let report = { lines: [] };
    report = upsert(report, line({ id: "order_rtt", value: "p95 90 ms", pass: true, where: "production", ...fixed }));
    report = upsert(report, line({ id: "datc", value: "171 of 171", pass: true, where: "local", ...fixed }));
    report = upsert(report, line({ id: "order_rtt", value: "p95 200 ms", pass: false, where: "production", ...fixed }));
    report = upsert(report, line({ id: "order_rtt", value: "p95 4 ms", pass: true, where: "wrangler dev", ...fixed }));
    assert.deepEqual(
      report.lines.map((l) => [l.id, l.where, l.value]),
      [
        ["datc", "local", "171 of 171"],
        ["order_rtt", "production", "p95 200 ms"],
        ["order_rtt", "wrangler dev", "p95 4 ms"],
      ],
    );
  });

  it("renders a ledger table: every metric present, FAIL only for a failed target, unmeasured said so", () => {
    const report = {
      lines: [
        line({ id: "datc", value: "171 of 171 passed, 0 failed, 0 skipped", pass: true, where: "local", ...fixed }),
        line({ id: "order_rtt", value: "p95 200 | ms", pass: false, where: "production", ...fixed }),
      ],
    };
    const table = renderTable(report);
    const rows = table.trim().split("\n");
    assert.equal(rows[0], "| Metric | Target | Value | Where | Date | Commit | Result |");
    assert.equal(rows.length, 2 + METRICS.length);
    assert.match(rows[2], /^\| DATC v3\.0 \| 100 percent, zero skipped \| 171 of 171 passed, 0 failed, 0 skipped \| local \| 2026-11-19 \| `abc123def456` \| pass \|$/);
    assert.match(rows[3], /Full 7 seat game .* not measured/);
    assert.match(rows[5], /p95 200 \\\| ms .* \*\*FAIL\*\* \|$/);
  });

  it("refuses an unknown metric or a missing verdict", () => {
    assert.throws(() => line({ id: "uptime", value: 1, pass: true, where: "x" }));
    assert.throws(() => line({ id: "datc", value: 1, pass: "yes", where: "x" }));
  });

  it("writes the JSON and its Markdown twin, and reads them back", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cabal-metrics-")), "metrics.json");
    assert.deepEqual(readReport(file), { lines: [] });
    record(line({ id: "full_game", value: "finished", pass: true, where: "wrangler dev", ...fixed }), file);
    record(line({ id: "datc", value: "171 of 171", pass: true, where: "local", ...fixed }), file);
    assert.deepEqual(readReport(file).lines.map((l) => l.id), ["datc", "full_game"]);
    const md = readFileSync(file.replace(/\.json$/, ".md"), "utf8");
    assert.match(md, /^# Phase 1 metrics/);
    assert.match(md, /\| Full 7 seat game \| .* \| finished \| wrangler dev \|/);
  });
});

describe("the DATC line", () => {
  const corpus = (over = {}) => ({ name: "DATC v3.0", total: 171, passed: 171, failed: 0, skipped: 0, checks: 1639, ...over });
  it("passes only with every case passed and none skipped", () => {
    assert.equal(datcLine({ engine: "0.1.0", corpora: [corpus()] }, "local", fixed).pass, true);
    assert.equal(datcLine({ engine: "0.1.0", corpora: [corpus({ passed: 170, skipped: 1 })] }, "local", fixed).pass, false);
    assert.equal(datcLine({ engine: "0.1.0", corpora: [corpus({ passed: 170, failed: 1 })] }, "local", fixed).pass, false);
    assert.equal(datcLine({ engine: "0.1.0", corpora: [corpus()] }, "local", fixed).value, "171 of 171 passed, 0 failed, 0 skipped");
    assert.throws(() => datcLine({ corpora: [] }, "local"));
  });
});
