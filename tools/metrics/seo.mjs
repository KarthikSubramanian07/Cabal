#!/usr/bin/env node
/**
 * Lighthouse SEO (issue #12's test plan: a score above 95): run Lighthouse's SEO category against
 * each page of a deployment, or of a production-like local stack (`wrangler pages dev` in front of
 * `wrangler dev`, so the Pages worker writes each page's head as it does in production), and print
 * a table of scores with every audit that failed.
 *
 *   node tools/metrics/seo.mjs <origin> [path ...] [--min 95]
 *
 * Needs Chrome (set CHROME_PATH where Lighthouse cannot find it) and fetches Lighthouse with npx.
 * A page kept out of search indexes on purpose (a table's page: its `robots` says `noindex`) fails
 * only the crawlability audit, and is reported as such rather than as a miss. It exits 1 when any
 * other page scores below `--min`.
 */
import { spawnSync } from "node:child_process";
import { isMain, option } from "./lib/report.mjs";

export const LIGHTHOUSE = "lighthouse@13.6.0";

/**
 * One page's verdict from a Lighthouse result: its SEO score out of 100, the audits that failed,
 * and whether the page asked to stay out of indexes (then a failed crawlability audit is expected).
 */
export function summarise(lhr, min = 95) {
  const seo = lhr.categories?.seo;
  if (!seo || seo.score === null || seo.score === undefined) throw new Error(`Lighthouse gave no SEO score for ${lhr.finalDisplayedUrl ?? "the page"}`);
  const failed = seo.auditRefs
    .map((ref) => lhr.audits[ref.id])
    .filter((a) => a && a.score !== null && a.score < 1 && !["manual", "notApplicable", "informative"].includes(a.scoreDisplayMode))
    .map((a) => a.id);
  const score = Math.round(seo.score * 100);
  const noindex = failed.length === 1 && failed[0] === "is-crawlable";
  return { url: lhr.finalDisplayedUrl ?? lhr.requestedUrl, score, failed, noindex, pass: noindex || score >= min };
}

/** Run Lighthouse's SEO category against one URL and return its result. */
export function lighthouse(url) {
  const run = spawnSync(
    "npx",
    ["--yes", LIGHTHOUSE, url, "--only-categories=seo", "--output=json", "--output-path=stdout", "--quiet", "--chrome-flags=--headless=new"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`Lighthouse printed no report for ${url}:\n${run.stderr.slice(-2000)}`);
  }
}

/** The verdicts as a Markdown table. */
export function seoTable(rows) {
  const out = ["| Page | SEO | Failed audits | Result |", "|---|---|---|---|"];
  for (const r of rows) {
    const path = new URL(r.url).pathname;
    out.push(`| \`${path}\` | ${r.score} | ${r.failed.length ? r.failed.join(", ") : "none"} | ${r.noindex ? "noindex by design" : r.pass ? "pass" : "**FAIL**"} |`);
  }
  return out.join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const origin = args.find((a) => /^https?:\/\//.test(a));
  if (!origin) {
    console.error("usage: node tools/metrics/seo.mjs <origin> [path ...] [--min 95]");
    process.exit(2);
  }
  const min = Number(option(args, "min", "95"));
  const skip = new Set(args.flatMap((a, i) => (a === "--min" ? [i, i + 1] : [])));
  const paths = args.filter((a, i) => a.startsWith("/") && !skip.has(i));
  const rows = (paths.length ? paths : ["/"]).map((path) => summarise(lighthouse(new URL(path, origin).toString()), min));
  console.log(seoTable(rows));
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}
