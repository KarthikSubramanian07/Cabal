/**
 * Self-serve account deletion (`DELETE /api/me`): the account and everything tied to it go; seats
 * become ghosts by each game's own rules; other players' records still add up.
 */
import { describe, expect, it } from "vitest";
import { DeleteMeResponse, type GameRecord, GameSettings, PlayerProfile } from "@cabal/protocol";
import { DELETED_HANDLE_HOLD_MS, handleKey } from "../src/handles.js";
import { LIMITS } from "../src/room.js";
import { hashToken } from "../src/tokens.js";
import { Client, call, createAs, index, inviteSubstitute, joinAs, newPlayer, serverEnv, sql, start, summary, until } from "./helpers.js";

const db = () => serverEnv.DB!;
const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as const;
let games = 0;
const code = () => `DL${(++games).toString(36).toUpperCase().padStart(4, "0")}`;

/** Let every handle hold run out, as if the hold's hour had passed. */
const expireHolds = () => db().prepare("UPDATE handle_holds SET until = 0").run();

const remove = (secret: string, handle: string) => call("/api/me", secret, { method: "DELETE", body: JSON.stringify({ handle }) });

async function deleted(secret: string, handle: string): Promise<DeleteMeResponse> {
  const res = await remove(secret, handle);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  return DeleteMeResponse.parse(await res.json());
}

/** A finished public game with the given players at the first seats, rated when three are signed in. */
function finished(ids: string[], first: number): GameRecord {
  const scores = Object.fromEntries(POWERS.map((p, i) => [p, i === first ? 1 : 0]));
  return {
    gameId: code(),
    result: "solo",
    reason: "solo",
    winners: [POWERS[first]!],
    scores,
    settings: GameSettings.parse({ visibility: "public" }),
    cluster: "standard:full:async",
    phaseCount: 12,
    movementPhases: 8,
    createdAt: 1,
    finishedAt: Date.now(),
    ledger: {},
    seats: POWERS.map((power, i) => ({ power, kind: ids[i] ? "human" : "ai", name: ids[i] ? `Name${i}` : "Automaton", centers: i === first ? 18 : 2, eliminated: false })),
    players: POWERS.map((power, i) => ({
      power,
      stint: 0,
      kind: ids[i] ? "human" : "ai",
      playerId: ids[i] ?? null,
      name: ids[i] ? `Name${i}` : "Automaton",
      joinedAt: 1,
      substitute: false,
      leftReason: null,
      civilDisorder: false,
      phasesDue: ids[i] ? 8 : 0,
      phasesOnTime: ids[i] ? 8 : 0,
      phasesLate: 0,
      ledger: { kept: ids[i] ? 2 : 0, broken: 0, void: 0 },
    })),
  };
}

describe("deleting an account", () => {
  it("asks for the handle, and only the signed-in player's own", async () => {
    const ann = await newPlayer();
    const bob = await newPlayer();
    expect((await call("/api/me", null, { method: "DELETE", body: JSON.stringify({ handle: ann.player.handle }) })).status).toBe(401);
    const wrong = await remove(ann.secret, bob.player.handle);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "handle_mismatch" });
    expect((await call("/api/me", ann.secret, { method: "DELETE", body: "{}" })).status).toBe(400);
    expect((await call("/api/me", ann.secret)).status).toBe(200);
    // Any way of writing the handle that reads the same will do.
    expect(await deleted(ann.secret, ann.player.handle.toUpperCase())).toEqual({ deleted: true, games: 0, unreached: 0 });
    expect((await call("/api/me", ann.secret)).status).toBe(401);
    expect((await call("/api/me", bob.secret)).status).toBe(200);
  });

  it("forgets the account, its devices, its rating and its ledger, and frees the handle after a hold", async () => {
    const [ann, bob, cat] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    // A second device, a subscribed browser and switched-off notices: all of them go.
    const recovery = (await (await call("/api/me/recovery", ann.secret, { method: "POST" })).json()) as { recoveryCode: string };
    const other = (await (await call("/api/players/recover", null, { method: "POST", body: JSON.stringify({ code: recovery.recoveryCode }) })).json()) as { secret: string };
    await db()
      .prepare("INSERT INTO push_subscriptions (endpoint, player_id, session_hash, p256dh, auth, created_at) VALUES (?, ?, ?, 'k', 'a', ?)")
      .bind(`https://fcm.googleapis.com/fcm/send/${ann.player.id}`, ann.player.id, hashToken(ann.secret), Date.now())
      .run();
    await db().prepare("INSERT INTO notification_preferences (player_id, press, updated_at) VALUES (?, 0, ?)").bind(ann.player.id, Date.now()).run();
    const game = finished([ann.player.id, bob.player.id, cat.player.id], 0);
    await index().recordGame(game);
    const bobBefore = (await db().prepare("SELECT rating, games FROM ratings WHERE player_id = ?").bind(bob.player.id).first<{ rating: number; games: number }>())!;

    const result = await deleted(ann.secret, ann.player.handle);
    expect(result.games).toBe(1);

    const count = async (table: string, column = "player_id") =>
      (await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(ann.player.id).first<{ n: number }>())!.n;
    for (const table of ["player_sessions", "push_subscriptions", "notification_preferences", "ratings", "rating_history", "player_stats", "handle_aliases", "game_players"]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count("players", "id")).toBe(0);
    expect((await call("/api/me", other.secret)).status).toBe(401);
    expect((await call(`/api/players/${ann.player.handle}`, null)).status).toBe(404);
    expect((await call(`/api/players/${ann.player.handle}/ratings`, null)).status).toBe(404);
    // The recovery code is dead with the account.
    expect((await call("/api/players/recover", null, { method: "POST", body: JSON.stringify({ code: recovery.recoveryCode }) })).status).toBe(401);

    // The game still adds up: the seat is a ghost's, other players keep what the game gave them,
    // and nothing anywhere still names the deleted player.
    const seats = (await db().prepare("SELECT power, player_id, name FROM game_players WHERE game_id = ? ORDER BY power").bind(game.gameId).all<{ power: string; player_id: string | null; name: string | null }>()).results;
    expect(seats.find((s) => s.power === "AUSTRIA")).toEqual({ power: "AUSTRIA", player_id: null, name: "Ghost" });
    const record = (await index().getGame(game.gameId))!;
    expect(record.seats.find((s) => s.power === "AUSTRIA")!.name).toBe("Ghost");
    expect(record.seats.find((s) => s.power === "ENGLAND")!.name).toBe("Name1");
    const bobAfter = (await db().prepare("SELECT rating, games FROM ratings WHERE player_id = ?").bind(bob.player.id).first<{ rating: number; games: number }>())!;
    expect(bobAfter).toEqual(bobBefore);
    const dump = JSON.stringify((await db().prepare("SELECT * FROM rating_history").all()).results) + JSON.stringify((await db().prepare("SELECT * FROM games_index WHERE game_id = ?").bind(game.gameId).all()).results);
    expect(dump).not.toContain(ann.player.id);
    const bobProfile = PlayerProfile.parse(await (await call(`/api/players/${bob.player.handle}`, null)).json());
    expect(bobProfile.recent[0]).toMatchObject({ gameId: game.gameId });

    // The handle is held a while, so a room that missed the deletion cannot link a newcomer; then
    // it is free for someone new.
    const early = await call("/api/players", null, { method: "POST", body: JSON.stringify({ handle: ann.player.handle }) });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: "handle_taken" });
    const hold = await db().prepare("SELECT until FROM handle_holds WHERE handle_key = ?").bind(handleKey(ann.player.handle)).first<{ until: number }>();
    expect(hold!.until).toBeGreaterThan(Date.now() + DELETED_HANDLE_HOLD_MS - 60_000);
    await expireHolds();
    const heir = await newPlayer(ann.player.handle);
    expect(heir.player.id).not.toBe(ann.player.id);
    // Deleting again is a 401, not a crash: the secret is gone with the account.
    expect((await remove(ann.secret, ann.player.handle)).status).toBe(401);
  });

  it("opens a lobby seat again and hands the table to whoever sat down next", async () => {
    const [ann, bob] = await Promise.all([newPlayer(), newPlayer()]);
    const table = await createAs(ann.secret, { aiFill: true });
    const res = await joinAs(bob.secret, table.gameId);
    const bobSeat = (await res.json()) as { gameId: string; token: string; power: string };
    expect((await deleted(ann.secret, ann.player.handle)).games).toBe(1);
    const s = await summary(table.gameId);
    expect(s.status).toBe("lobby");
    expect(s.seats.find((x) => x.power === table.power)).toMatchObject({ kind: "open", name: null });
    expect(s.host).toBe(bobSeat.power);
    // Bob may now start the table the deleted player had set.
    expect((await start(bobSeat)).status).toBe(200);
    expect((await summary(table.gameId)).status).toBe("active");
    expect(await sql(table.gameId, "SELECT * FROM stints WHERE player_id = ?", ann.player.id)).toEqual([]);
  });

  it("lets the next player who takes a reopened lobby seat see it among their games", async () => {
    const [ann, bob, cat] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const table = await createAs(ann.secret, { aiFill: true });
    expect((await joinAs(bob.secret, table.gameId)).status).toBe(200);
    expect((await deleted(ann.secret, ann.player.handle)).games).toBe(1);
    // No anonymous holder stays behind in the index for a seat that was never played.
    const left = await db().prepare("SELECT * FROM game_players WHERE game_id = ? AND power = ?").bind(table.gameId, table.power).all();
    expect(left.results).toEqual([]);
    // Cat sits in the very seat the deleted player opened again.
    const sat = await joinAs(cat.secret, table.gameId, { power: table.power });
    expect(sat.status, await sat.clone().text()).toBe(200);
    await until(async () => {
      const mine = (await (await call("/api/me/games", cat.secret)).json()) as { games: { gameId: string }[] };
      return mine.games.some((g) => g.gameId === table.gameId);
    }, "cat's games list to show the table");
    const rows = (await db().prepare("SELECT stint, player_id FROM game_players WHERE game_id = ? AND power = ?").bind(table.gameId, table.power).all<{ stint: number; player_id: string | null }>()).results;
    expect(rows).toEqual([{ stint: 1, player_id: cat.player.id }]);
    // So deleting Cat's account later reaches this room too, and her name leaves the seat.
    expect((await deleted(cat.secret, cat.player.handle)).games).toBe(1);
    expect((await summary(table.gameId)).seats.find((x) => x.power === table.power)).toMatchObject({ kind: "open", name: null });
  });

  it("takes the name off a listing whose room could not be told", async () => {
    const ann = await newPlayer();
    const gameId = code();
    const now = Date.now();
    await db()
      .prepare(
        `INSERT INTO games_live (game_id, status, settings_json, cluster, host_name, humans, open_seats, phase, deadline_at, created_at, updated_at)
         VALUES (?, 'lobby', '{}', 'standard:full:async', ?, 1, 6, 'S1901M', NULL, ?, ?)`,
      )
      .bind(gameId, ann.player.handle, now, now)
      .run();
    await db()
      .prepare("INSERT INTO game_players (game_id, power, stint, player_id, kind, name, joined_at, substitute, status) VALUES (?, 'FRANCE', 0, ?, 'human', ?, ?, 0, 'playing')")
      .bind(gameId, ann.player.id, ann.player.handle, now)
      .run();
    await deleted(ann.secret, ann.player.handle);
    expect(await db().prepare("SELECT host_name FROM games_live WHERE game_id = ?").bind(gameId).first()).toEqual({ host_name: "Ghost" });
  });

  it("ends a lobby nobody is left in", async () => {
    const ann = await newPlayer();
    const table = await createAs(ann.secret);
    await deleted(ann.secret, ann.player.handle);
    const s = await summary(table.gameId);
    expect(s.status).toBe("abandoned");
    expect(s.finished).toMatchObject({ result: "abandoned", reason: "lobby_emptied" });
  });

  it("leaves a ghost at a running game's seat: civil disorder, vacant for a substitute, played by the bot", async () => {
    const [ann, bob] = await Promise.all([newPlayer(), newPlayer()]);
    const table = await createAs(ann.secret, { aiFill: true });
    const bobSeat = (await (await joinAs(bob.secret, table.gameId)).json()) as { gameId: string; token: string; power: string };
    expect((await start({ ...table })).status).toBe(200);
    const annSocket = await Client.connect(table.gameId, table.token);
    await annSocket.next("welcome");
    const watcher = await Client.connect(table.gameId, bobSeat.token);
    await watcher.next("welcome");

    await deleted(ann.secret, ann.player.handle);
    expect((await annSocket.untilClosed()).code).toBe(4001);
    const seats = await watcher.next("seats", (m) => m.p.seats.some((x) => x.power === table.power && x.kind === "civil_disorder"));
    const ghost = seats.p.seats.find((x) => x.power === table.power)!;
    expect(ghost).toMatchObject({ kind: "civil_disorder", name: "Ghost", handle: null, autopilot: true });
    expect(ghost.missed).toBeGreaterThanOrEqual(LIMITS.vacantAfter);
    expect(await sql(table.gameId, "SELECT player_id, token_hash FROM seats WHERE power = ?", table.power)).toEqual([{ player_id: null, token_hash: null }]);
    // The old seat token is dead on every device.
    const again = await Client.connect(table.gameId, table.token);
    expect((await again.next("error")).p.code).toBe("bad_token");
    // A seated player may hand the seat on at once.
    expect((await inviteSubstitute(bobSeat, table.power)).status).toBe(200);
    // Nothing in the room still names the deleted player.
    expect(await sql(table.gameId, "SELECT * FROM seats WHERE player_id = ?", ann.player.id)).toEqual([]);
    expect(await sql(table.gameId, "SELECT * FROM stints WHERE player_id = ?", ann.player.id)).toEqual([]);
    watcher.close();
  });

  it("keeps a late record from tying a game back to a deleted player", async () => {
    const [ann, bob, cat] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    await deleted(ann.secret, ann.player.handle);
    // A room that could not be told hands over its record afterwards, still naming the player.
    const game = finished([ann.player.id, bob.player.id, cat.player.id], 1);
    await index().recordGame(game);
    const rows = (await db().prepare("SELECT power, player_id, name FROM game_players WHERE game_id = ?").bind(game.gameId).all<{ power: string; player_id: string | null; name: string | null }>()).results;
    expect(rows.find((r) => r.power === "AUSTRIA")).toMatchObject({ player_id: null, name: "Ghost" });
    expect((await index().getGame(game.gameId))!.seats.find((s) => s.power === "AUSTRIA")!.name).toBe("Ghost");
    expect(await db().prepare("SELECT 1 FROM players WHERE id = ?").bind(ann.player.id).first()).toBeNull();
    // The ghost no longer counts as a signed-in player, so the game falls below the rated bar.
    expect(await db().prepare("SELECT 1 AS x FROM rated_games WHERE game_id = ?").bind(game.gameId).first()).toBeNull();
    // The two players still signed in are on the record; the game had too few to be rated.
    await until(async () => (await db().prepare("SELECT games FROM player_stats WHERE player_id = ?").bind(bob.player.id).first<{ games: number }>())?.games === 1, "bob's totals");
  });

  it("is idempotent: a room told twice changes nothing", async () => {
    const [ann, bob] = await Promise.all([newPlayer(), newPlayer()]);
    const table = await createAs(ann.secret, { aiFill: true });
    await joinAs(bob.secret, table.gameId);
    await deleted(ann.secret, ann.player.handle);
    const before = await summary(table.gameId);
    const again = await serverEnv.GAME_ROOM.get(serverEnv.GAME_ROOM.idFromName(table.gameId)).fetch(
      new Request("https://room/forsake", { method: "POST", body: JSON.stringify({ playerId: ann.player.id }) }),
    );
    expect(await again.json()).toEqual({ gameId: table.gameId, seats: [], unplayed: true });
    expect({ ...(await summary(table.gameId)), serverTime: 0 }).toEqual({ ...before, serverTime: 0 });
  });
});
