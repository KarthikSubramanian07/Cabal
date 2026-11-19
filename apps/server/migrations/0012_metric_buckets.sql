-- Browser timings (order round trips, landing to a game) as daily histograms instead of one row per
-- sample, so what anonymous beacons can write is bounded whatever the traffic: at most one row per
-- metric, day, continent and bin, and at most `BEACON_SAMPLES_PER_DAY` samples a day in all
-- (metrics.ts). Server-side events (DATC runs, finished games) stay in metric_events.
-- D1 only. Never edit a migration that has shipped.
CREATE TABLE IF NOT EXISTS metric_buckets (
  -- order_rtt | landing_to_game
  metric TEXT NOT NULL,
  -- Start of the UTC day, in ms.
  day INTEGER NOT NULL,
  -- Two-letter continent code Cloudflare saw the beacon from, or XX.
  region TEXT NOT NULL,
  -- Histogram bin (stats.ts `binOf`): 0 below 1 ms, then bins 5 percent wide.
  bin INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (metric, day, region, bin)
);
-- Samples accepted per UTC day, for the daily cap.
CREATE TABLE IF NOT EXISTS metric_beacon_days (
  day INTEGER PRIMARY KEY,
  samples INTEGER NOT NULL
);
