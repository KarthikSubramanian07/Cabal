/**
 * A table's share card against the real server: the edge reads the table's saved game and colours
 * the opening's supply centres into the board, as a link preview fetches it. Run once, on desktop.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readPalette } from "../src/agent/png.js";
// @ts-expect-error: plain ES modules with no type declarations
import { createGame, startGame } from "../../../tools/metrics/lib/probe.mjs";

const layout = JSON.parse(readFileSync(new URL("../src/agent/share-card.json", import.meta.url), "utf8")) as {
  land: number[];
  notch: number[];
  centres: Record<string, number>;
  notches: Record<string, number[]>;
};
const server = process.env.LIVE_ORIGIN ?? `http://localhost:${process.env.LIVE_SERVER_PORT ?? 8799}`;
const OPENING: Record<string, number> = { AUSTRIA: 3, ENGLAND: 3, FRANCE: 3, GERMANY: 3, ITALY: 3, RUSSIA: 4, TURKEY: 3 };

test("a table's link preview shows its board and its centres", async ({ page, request, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "one table is enough");
  const game = (await createGame(server, { stem: "Card" })) as { gameId: string };
  await startGame(server, game);

  // The table's page names the card in its head, before any script runs.
  const html = await (await request.get(`/g/${game.gameId}`, { headers: { Accept: "text/html" } })).text();
  expect(html).toContain(`/share/g/${game.gameId}.png`);

  const res = await request.get(`/share/g/${game.gameId.toLowerCase()}.png`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  const card = new Uint8Array(await res.body());
  const palette = readPalette(card);
  for (const [power, held] of Object.entries(OPENING)) {
    const notches = layout.notches[power]!;
    const filled = notches.filter((i) => palette[i]!.join() !== layout.notch.join()).length;
    expect(filled, power).toBe(held);
  }
  expect(palette[layout.centres["PAR"]!]).not.toEqual(layout.land);
  expect(palette[layout.centres["BEL"]!]).toEqual(layout.land);

  // Look at it the way a person would: the card on its own, and as a page shows it.
  const out = process.env.SHARE_SHOTS;
  if (out) {
    writeFileSync(`${out}/share-card-${game.gameId}.png`, card);
    await page.goto(`${baseURL}/share/g/${game.gameId}.png`);
    await page.screenshot({ path: `${out}/share-card-page.png` });
  }

  // A code that names no game is a 404, and so its preview shows nothing.
  expect((await request.get("/share/g/ZZZZZZ.png")).status()).toBe(404);
});
