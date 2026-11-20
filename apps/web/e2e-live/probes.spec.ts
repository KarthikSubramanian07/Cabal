/**
 * The phase 1 probes (tools/metrics) against the local server the live suite starts: the order
 * round trip and a full seven seat game with no operator. Under `wrangler dev` this is a sanity
 * bound only (a CI runner is not a browser in Europe or North America); the recorded figures come
 * from a maintainer's run against production. Run once, on the desktop project.
 */
import { expect, test } from "./fixtures.js";
// @ts-expect-error: plain ES modules with no type declarations
import { playFullGame } from "../../../tools/metrics/full-game.mjs";
// @ts-expect-error: plain ES modules with no type declarations
import { measureOrderRtt } from "../../../tools/metrics/order-rtt.mjs";

/** The server itself under wrangler dev; a deployment's own origin (its /api) when LIVE_ORIGIN is set. */
const server = process.env.LIVE_ORIGIN ?? `http://localhost:${process.env.LIVE_SERVER_PORT ?? 8799}`;

test.describe("phase 1 probes, live", () => {
  test.skip(({ isMobile }) => isMobile, "the probes are not a browser: once is enough");

  test("the order round trip answers every orders.set, well inside the target", async ({}, info) => {
    const result = (await measureOrderRtt(server, { n: 30, gapMs: 110 })) as { n: number; p50: number; p95: number; p99: number };
    info.annotations.push({ type: "order_rtt", description: JSON.stringify(result) });
    expect(result.n).toBe(30);
    // A sanity bound, not the target: on a quiet machine the round trip is a few milliseconds, but
    // this test shares the machine with the rest of the suite (and a laptop with everything else),
    // where p95 has reached 300 ms. A broken path takes seconds or never answers. The 150 ms target
    // is judged where it applies, by `tools/metrics/order-rtt.mjs` against production.
    expect(result.p95).toBeLessThan(1000);
  });

  test("a full game with two people and five bots finishes with no operator", async ({}, info) => {
    test.slow();
    const result = (await playFullGame(server, { humans: 2, untilYear: 1902, timeoutMs: 120_000 })) as { status: string; result: string; phases: number };
    info.annotations.push({ type: "full_game", description: JSON.stringify(result) });
    expect(result.status).toBe("finished");
    expect(["draw", "solo"]).toContain(result.result);
    expect(result.phases).toBeGreaterThanOrEqual(4);
  });
});
