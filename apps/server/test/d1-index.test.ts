/** The D1 adapter of the games index, against a real local D1 database with the real migrations. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type GameListing, type GameRecord, GameSettings } from "@cabal/protocol";
import { D1Index } from "../src/d1-index.js";
import { D1_SCHEMA, index, nextIp, registry, serverEnv } from "./helpers.js";

const db = () => serverEnv.DB!;

const record = (gameId: string, over: Partial<GameRecord> = {}): GameRecord => ({
  gameId,
  result: "draw",
  reason: "vote",
  winners: ["FRANCE", "ITALY"],
  scores: { FRANCE: 0.5, ITALY: 0.5 },
  settings: GameSettings.parse({}),
  cluster: "standard:full:async",
  phaseCount: 12,
  createdAt: 1_000,
  finishedAt: 2_000,
  ledger: { FRANCE: { kept: 2, broken: 1, void: 0 } },
  seats: [{ power: "FRANCE", kind: "human", name: "Ann", centers: 9, eliminated: false }],
  ...over,
});

const listing = (gameId: string, over: Partial<GameListing> = {}): GameListing => ({
  gameId,
  status: "lobby",
  settings: GameSettings.parse({ visibility: "public" }),
  cluster: "standard:full:async",
  hostName: "Ann",
  humans: 1,
  openSeats: 6,
  phase: "S1901M",
  deadlineAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

describe("the D1 index", () => {
  it("is the deployment's index, at the newest migration, with every table in place", async () => {
    expect(index()).toBeInstanceOf(D1Index);
    expect(await index().schemaVersion()).toBe(D1_SCHEMA);
    const tables = (await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["games_index", "games_live", "players", "player_sessions", "handle_aliases", "game_players", "ratings", "rating_history", "rated_games", "player_stats", "index_meta"]),
    );
    // The table's own constraint admits abandoned games and nothing invented.
    await expect(
      db().prepare("INSERT INTO games_index (game_id, result, winners_json, scores_json, settings_json, phase_count, finished_at, ledger_json) VALUES ('BADBAD', 'cancelled', '[]', '{}', '{}', 0, 0, '{}')").run(),
    ).rejects.toThrow();
  });

  it("records a game idempotently and reads it back", async () => {
    await index().recordGame(record("D1REC1"));
    await index().recordGame(record("D1REC1", { phaseCount: 13 }));
    expect(await index().getGame("D1REC1")).toEqual(record("D1REC1", { phaseCount: 13 }));
    expect((await db().prepare("SELECT COUNT(*) AS n FROM games_index WHERE game_id = 'D1REC1'").first<{ n: number }>())!.n).toBe(1);
    expect(await index().getGame("NOSUCH")).toBeNull();
    await expect(index().recordGame({ ...record("D1BAD1"), result: "cancelled" as never })).rejects.toThrow();
    expect(await index().getGame("D1BAD1")).toBeNull();
  });

  it("lists the most recently ended public games first, pages by time and filters by result", async () => {
    const far = 9_100_000_000_000;
    const settings = GameSettings.parse({ visibility: "public" });
    await index().recordGame(record("D1LST1", { finishedAt: far + 1, settings }));
    await index().recordGame(record("D1LST2", { finishedAt: far + 2, result: "abandoned", reason: "no_orders", winners: [], scores: {}, settings }));
    await index().recordGame(record("D1LST3", { finishedAt: far + 3, result: "solo", winners: ["FRANCE"], settings }));
    // Recorded, but never listed: an unlisted game, and a public one that ended before a phase was played.
    await index().recordGame(record("D1LST4", { finishedAt: far + 4 }));
    await index().recordGame(record("D1LST5", { finishedAt: far + 5, settings, phaseCount: 0 }));
    expect((await index().getGame("D1LST4"))?.gameId).toBe("D1LST4");
    expect((await index().listGames({ limit: 3 })).map((g) => g.gameId)).toEqual(["D1LST3", "D1LST2", "D1LST1"]);
    expect((await index().listGames({ limit: 2, before: far + 3 })).map((g) => g.gameId)).toEqual(["D1LST2", "D1LST1"]);
    expect((await index().listGames({ limit: 5, result: "abandoned" }))[0]!.gameId).toBe("D1LST2");
    const res = await SELF.fetch("http://cabal/api/games?limit=2", { headers: { "cf-connecting-ip": nextIp() } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { games: GameRecord[] }).games.map((g) => g.gameId)).toEqual(["D1LST3", "D1LST2"]);
  });

  it("keeps listings fresh, and a listing never outlives its game's record", async () => {
    await index().upsertListing(listing("D1LIV1"));
    await index().upsertListing(listing("D1LIV1", { openSeats: 3 }));
    const open = await index().listListings({ status: "open", now: Date.now(), limit: 100 });
    expect(open.find((l) => l.gameId === "D1LIV1")?.openSeats).toBe(3);
    await index().recordGame(record("D1LIV1"));
    expect((await index().listListings({ status: "open", now: Date.now(), limit: 100 })).some((l) => l.gameId === "D1LIV1")).toBe(false);
    // A refresh that arrives after the record is ignored.
    await index().upsertListing(listing("D1LIV1"));
    expect((await index().listListings({ status: "open", now: Date.now(), limit: 100 })).some((l) => l.gameId === "D1LIV1")).toBe(false);
  });

  it("copies the Registry's rows across once, never overwriting what D1 already has", async () => {
    // What the Registry held before the switch: a game D1 has never seen, one D1 has a newer copy of, and a listing.
    await registry().recordGame(record("CPYAA1", { finishedAt: 5 }));
    await registry().recordGame(record("CPYAA2", { finishedAt: 6, phaseCount: 1 }));
    await registry().upsertListing(listing("CPYAA3"));
    await index().recordGame(record("CPYAA2", { finishedAt: 7, phaseCount: 30 }));
    await db().prepare("DELETE FROM index_meta WHERE key = 'registry_copy'").run();

    const d1 = index() as D1Index;
    const copied = await d1.copyFromRegistry(registry());
    expect(copied!.games).toBeGreaterThanOrEqual(2);
    expect(copied!.listings).toBeGreaterThanOrEqual(1);
    expect(await index().getGame("CPYAA1")).toEqual(record("CPYAA1", { finishedAt: 5 }));
    expect((await index().getGame("CPYAA2"))?.phaseCount).toBe(30);
    expect((await index().listListings({ status: "open", now: Date.now(), limit: 100 })).some((l) => l.gameId === "CPYAA3")).toBe(true);
    // Done is done: the second call copies nothing and says so.
    await registry().recordGame(record("CPYAA4"));
    expect(await d1.copyFromRegistry(registry())).toBeNull();
    expect(await index().getGame("CPYAA4")).toBeNull();
    const marker = await db().prepare("SELECT value FROM index_meta WHERE key = 'registry_copy'").first<{ value: string }>();
    expect(JSON.parse(marker!.value)).toEqual(copied);
  });
});
