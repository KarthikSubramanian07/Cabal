#!/usr/bin/env node
/**
 * Run the DATC corpus and record its totals as the phase 1 "DATC" metric (issue #57).
 *
 *   ADMIN_TOKEN=... node scripts/report-datc.mjs https://cabal-server.karthik-e5e.workers.dev
 *   node scripts/report-datc.mjs --dry-run          # run and print the report, send nothing
 *
 * It runs `cargo run -p cabal-cli -- datc` at the repository root, reads the DATC v3.0 line
 * ("DATC v3.0: 171 cases, 171 passed, 0 failed; ..."), counts a case that neither passed nor failed
 * as skipped (the closing "skipped" total counts orders the corpus has no expectation for, not
 * cases), names the commit, and posts the totals to
 * `POST /api/metrics/datc` with the admin token as the bearer. The token is read from the
 * environment, never from the command line, so it stays out of shell history.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** "DATC v3.0: 171 cases, 171 passed, 0 failed; ..." -> case totals, or null when the line is missing. */
export function parseTotals(output) {
  const m = /^DATC v3\.0: (\d+) cases, (\d+) passed, (\d+) failed/m.exec(output);
  if (!m) return null;
  const [cases, passed, failed] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { passed, failed, skipped: cases - passed - failed };
}

const run = spawnSync("cargo", ["run", "-q", "-p", "cabal-cli", "--", "datc"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const totals = parseTotals(run.stdout ?? "");
if (!totals) {
  console.error(run.stdout, run.stderr);
  console.error("cabal datc did not print its totals");
  process.exit(1);
}
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const engine = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).packages.find((p) => p.name === "cabal-engine")?.version;
const report = { ...totals, commit, ...(engine ? { engine } : {}) };
console.log(JSON.stringify(report));
if (dryRun) process.exit(totals.failed === 0 && totals.skipped === 0 ? 0 : 1);

const res = await fetch(new URL("/api/metrics/datc", origin), {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(report),
});
console.log(`${res.status} ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
