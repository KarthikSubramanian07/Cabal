#!/usr/bin/env node
/**
 * DATC v3.0 (docs/PLAN.md section 8, issue #57): run the corpus with `cabal datc --json` and record
 * its totals. Passes when every case passed and none was skipped.
 *
 *   node tools/metrics/datc.mjs [--record <where>]
 *
 * Without `--record` it prints the line and writes nothing. The same JSON is what CI uploads as the
 * `datc` artefact, and what apps/server/scripts/report-datc.mjs posts to a deployment.
 */
import { spawnSync } from "node:child_process";
import { ROOT, isMain, line, option, record } from "./lib/report.mjs";

/** The `cabal datc --json` document, from a run at the repository root. */
export function runDatc() {
  const run = spawnSync("cargo", ["run", "-q", "-p", "cabal-cli", "--", "datc", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`cabal datc --json printed no report:\n${run.stdout}\n${run.stderr}`);
  }
}

/** The DATC v3.0 corpus's line from a report: passes only with every case passed and none skipped. */
export function datcLine(report, where, extra = {}) {
  const corpus = report.corpora.find((c) => c.name === "DATC v3.0");
  if (!corpus) throw new Error("the report has no DATC v3.0 corpus");
  const pass = corpus.failed === 0 && corpus.skipped === 0 && corpus.passed === corpus.total;
  return line({
    id: "datc",
    value: `${corpus.passed} of ${corpus.total} passed, ${corpus.failed} failed, ${corpus.skipped} skipped`,
    pass,
    where,
    detail: { engine: report.engine, checks: corpus.checks },
    ...extra,
  });
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const report = runDatc();
  const where = option(args, "record", null);
  const l = datcLine(report, where ?? "local");
  console.log(JSON.stringify(l));
  if (where) record(l);
  process.exitCode = l.pass ? 0 : 1;
}
