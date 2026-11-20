/**
 * Percentiles for the phase 1 probes. Nearest rank, as the server's own summary uses: the p-th
 * percentile of n sorted values is the value at rank ceil(p * n), so a p95 is a figure that was
 * actually measured, never an interpolation between two.
 */

/** The `fraction` (0 to 1) percentile of `values`, by nearest rank; null for no values. */
export function percentile(values, fraction) {
  if (!(fraction >= 0 && fraction <= 1)) throw new RangeError(`percentile fraction must be within 0 and 1, not ${fraction}`);
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

/** Count, p50, p95, p99 and the extremes of a set of timings, rounded to a tenth of a millisecond. */
export function summarise(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: finite.length,
    p50: round(percentile(finite, 0.5)),
    p95: round(percentile(finite, 0.95)),
    p99: round(percentile(finite, 0.99)),
    min: round(finite.length ? Math.min(...finite) : null),
    max: round(finite.length ? Math.max(...finite) : null),
  };
}
