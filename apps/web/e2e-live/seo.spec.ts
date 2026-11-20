/**
 * What a search index is told about a game, against the real server: the replay of a public game
 * that has ended may be kept, its table's page never is, and both name the table's own share card.
 * Run once, on desktop.
 */
import { expect, test } from "./fixtures.js";
// @ts-expect-error: plain ES modules with no type declarations
import { playFullGame } from "../../../tools/metrics/full-game.mjs";

const server = process.env.LIVE_ORIGIN ?? `http://localhost:${process.env.LIVE_SERVER_PORT ?? 8799}`;

test("a public game's replay is indexed once it has ended, and its table never is", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "one game is enough");
  test.slow();
  const played = (await playFullGame(server, { humans: 2, untilYear: 1901, timeoutMs: 120_000, settings: { visibility: "public" } })) as { gameId: string; status: string };
  expect(played.status).toBe("finished");
  const code = played.gameId;

  const replay = await request.get(`/replay/${code}`, { headers: { Accept: "text/html" } });
  expect(replay.status()).toBe(200);
  expect(replay.headers()["x-robots-tag"]).toBeUndefined();
  const replayHtml = await replay.text();
  expect(replayHtml).toContain('<meta name="robots" content="index, follow" />');
  expect(replayHtml).toContain(`<meta property="og:image" content="https://playcabal.pages.dev/share/g/${code}.png" />`);

  const table = await request.get(`/g/${code}`, { headers: { Accept: "text/html" } });
  expect(table.headers()["x-robots-tag"]).toBe("noindex");
  expect(await table.text()).toContain('<meta name="robots" content="noindex, follow" />');

  // The page agrees with the edge once it has loaded the game, rather than undoing what it said.
  await page.goto(`/replay/${code}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
  expect(await page.locator('meta[name="robots"]').count()).toBe(1);
});
