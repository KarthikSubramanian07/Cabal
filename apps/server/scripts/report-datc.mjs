#!/usr/bin/env node
/**
 * Run the DATC corpus and record its totals as the phase 1 "DATC" metric (issue #57).
 *
 *   ADMIN_TOKEN=... node scripts/report-datc.mjs https://cabal-server.karthik-e5e.workers.dev
 *   node scripts/report-datc.mjs --dry-run          # run and print the report, send nothing
 *
 * It runs `cabal datc --json` at the repository root (tools/metrics/datc.mjs), takes the DATC v3.0
 * corpus's totals (a case is skipped when no assertion was evaluated for it), names the commit, and
 * posts them to `POST /api/metrics/datc` with the admin token as the bearer. The token is read from
 * the environment, never from the command line, so it stays out of shell history.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDatc } from "../../../tools/metrics/datc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const origin = args.find((a) => !a.startsWith("--"));
if (!dryRun && !origin) {
  console.error("usage: ADMIN_TOKEN=... node scripts/report-datc.mjs <server origin> | --dry-run");
  process.exit(2);
}
if (!dryRun && !process.env.ADMIN_TOKEN) {
  console.error("set ADMIN_TOKEN in the environment");
  process.exit(2);
}

const datc = runDatc();
const corpus = datc.corpora.find((c) => c.name === "DATC v3.0");
if (!corpus) {
  console.error("cabal datc --json reported no DATC v3.0 corpus");
  process.exit(1);
}
const totals = { passed: corpus.passed, failed: corpus.failed, skipped: corpus.skipped };
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const report = { ...totals, commit, ...(datc.engine ? { engine: datc.engine } : {}) };
console.log(JSON.stringify(report));
if (dryRun) process.exit(totals.failed === 0 && totals.skipped === 0 ? 0 : 1);

const res = await fetch(new URL("/api/metrics/datc", origin), {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(report),
});
console.log(`${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
