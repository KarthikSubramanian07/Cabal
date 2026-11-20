/**
 * The phase 1 metrics report: `metrics.json` (one line per metric, the latest measurement of each)
 * and `metrics.md`, the same lines as a plain ledger table (metric, target, value, date, commit,
 * pass or fail). Each probe records its own line with `record`; the others are kept as they were.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
export const ROOT = join(HERE, "..", "..");
export const DEFAULT_JSON = join(HERE, "metrics.json");

/** The four metrics of docs/PLAN.md section 8, in its order, with their targets. */
export const METRICS = [
  { id: "datc", title: "DATC v3.0", target: "100 percent, zero skipped" },
  { id: "full_game", title: "Full 7 seat game", target: "finishes with no manual intervention" },
  { id: "landing_to_game", title: "Landing page to a game in progress", target: "under 60 s, AI seats filling the table" },
  { id: "order_rtt", title: "Order submit round trip", target: "p95 under 150 ms (Europe or North America)" },
];

/** The commit the measurement was taken against: the checked-out one, unless named. */
export function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * One measured line. `value` is what the target is judged on, in words a reader can check
 * (`171 of 171, 0 skipped`, `p95 84 ms`); `pass` is the verdict; `where` names the deployment
 * or machine it was measured on.
 */
export function line({ id, value, pass, where, commit = currentCommit(), date = new Date().toISOString().slice(0, 10), detail = {} }) {
  const metric = METRICS.find((m) => m.id === id);
  if (!metric) throw new Error(`unknown metric ${id}`);
  if (typeof pass !== "boolean") throw new Error(`a verdict for ${id} must be pass or fail`);
  return { id, title: metric.title, target: metric.target, value: String(value), pass, where: String(where), date, commit, detail };
}

export function readReport(file = DEFAULT_JSON) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed.lines) ? parsed : { lines: [] };
  } catch {
    return { lines: [] };
  }
}

/** The report with `next` in place of the earlier line for the same metric and place, in PLAN.md order. */
export function upsert(report, next) {
  const kept = report.lines.filter((l) => !(l.id === next.id && l.where === next.where));
  const order = (l) => METRICS.findIndex((m) => m.id === l.id);
  return { lines: [...kept, next].sort((a, b) => order(a) - order(b) || a.where.localeCompare(b.where)) };
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report as a Markdown table. A metric never measured says so; a failed target says FAIL. */
export function renderTable(report) {
  const rows = ["| Metric | Target | Value | Where | Date | Commit | Result |", "|---|---|---|---|---|---|---|"];
  for (const metric of METRICS) {
    const lines = report.lines.filter((l) => l.id === metric.id);
    if (lines.length === 0) {
      rows.push(`| ${cell(metric.title)} | ${cell(metric.target)} | not measured | | | | |`);
      continue;
    }
    for (const l of lines) {
      rows.push(`| ${cell(l.title)} | ${cell(l.target)} | ${cell(l.value)} | ${cell(l.where)} | ${l.date} | \`${cell(l.commit)}\` | ${l.pass ? "pass" : "**FAIL**"} |`);
    }
  }
  return rows.join("\n") + "\n";
}

/** Write the line into the report next to `file` (JSON) and its Markdown twin. Returns the report. */
export function record(next, file = DEFAULT_JSON) {
  const report = upsert(readReport(file), next);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(file.replace(/\.json$/, ".md"), `# Phase 1 metrics\n\nWritten by \`tools/metrics\`; see its README for the command behind each line.\n\n${renderTable(report)}`);
  return report;
}

/** `--name value` from argv, or the fallback. */
export function option(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

/** True when the module at `url` is the script node was asked to run. */
export function isMain(url) {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
