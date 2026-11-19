/**
 * Small, exact statistics over samples: what the metrics summary reports and what the cold start
 * harness gates on. Pure and dependency free, so Node runs this file as it is (type stripping) for
 * `scripts/cold-start.mjs` and the Worker bundles it for `/api/metrics`.
 */

export interface Summary {
  n: number;
  min: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * The `q` quantile (0 to 1) of `values` by linear interpolation between closest ranks (the method
 * spreadsheets call PERCENTILE.INC). Null for no samples.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile must be between 0 and 1, got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

const round = (x: number) => Math.round(x * 100) / 100;

/** The usual figures for one set of samples, rounded to hundredths. Null for no samples. */
export function summarise(values: readonly number[]): Summary | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const q = (p: number) => round(quantile(finite, p)!);
  return { n: finite.length, min: q(0), median: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) };
}

export interface Regression {
  metric: string;
  base: number;
  head: number;
  limit: number;
}

/**
 * Medians of `head` that are slower than `base` by more than `ratio`, after an absolute allowance
 * of `slackMs` (so a 2 ms step can never fail a 50 percent gate on noise alone).
 */
export function regressions(
  base: Record<string, Summary | null>,
  head: Record<string, Summary | null>,
  metrics: readonly string[],
  ratio: number,
  slackMs: number,
): Regression[] {
  const out: Regression[] = [];
  for (const metric of metrics) {
    const b = base[metric];
    const h = head[metric];
    if (!b || !h) continue;
    const limit = round(b.median * ratio + slackMs);
    if (h.median > limit) out.push({ metric, base: b.median, head: h.median, limit });
  }
  return out;
}

/** Medians over their ceiling: `{ metric: ceilingMs }`. A metric with no samples is over. */
export function overBudget(head: Record<string, Summary | null>, ceilings: Record<string, number>): { metric: string; median: number | null; ceiling: number }[] {
  const out: { metric: string; median: number | null; ceiling: number }[] = [];
  for (const [metric, ceiling] of Object.entries(ceilings)) {
    const median = head[metric]?.median ?? null;
    if (median === null || median > ceiling) out.push({ metric, median, ceiling });
  }
  return out;
}

// ---------- histograms ----------

/** Histogram bins grow by this factor: a bin's middle is within 2.5 percent of any value in it. */
const BIN_GROWTH = 1.05;
const LOG_GROWTH = Math.log(BIN_GROWTH);

/** The bin a timing falls in: 0 below 1 ms, then `[1.05^(k-1), 1.05^k)` for bin k. */
export function binOf(ms: number): number {
  if (!(ms >= 1)) return 0;
  return 1 + Math.floor(Math.log(ms) / LOG_GROWTH);
}

/** The value a bin stands for: the geometric middle of its edges (0.5 ms for bin 0). */
export function binValue(bin: number): number {
  return bin <= 0 ? 0.5 : BIN_GROWTH ** (bin - 0.5);
}

/**
 * `summarise` over a histogram of `[bin, count]` pairs, every sample read as its bin's value. The
 * same interpolation as `quantile`, so a figure is within 2.5 percent of the exact one. Null for no
 * samples.
 */
export function summariseBins(bins: Iterable<readonly [number, number]>): Summary | null {
  const sorted = [...bins].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;
  // The value of the sample at 0-based rank `r`.
  const at = (r: number) => {
    let seen = 0;
    for (const [bin, n] of sorted) {
      seen += n;
      if (r < seen) return binValue(bin);
    }
    return binValue(sorted.at(-1)![0]);
  };
  const q = (p: number) => {
    const pos = (total - 1) * p;
    const low = Math.floor(pos);
    const a = at(low);
    return round(a + (at(Math.ceil(pos)) - a) * (pos - low));
  };
  return { n: total, min: q(0), median: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) };
}
