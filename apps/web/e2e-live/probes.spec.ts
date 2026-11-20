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
    // A loose bound: on one machine the round trip is a few milliseconds; 150 ms is the real target.
    expect(result.p95).toBeLessThan(150);
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
