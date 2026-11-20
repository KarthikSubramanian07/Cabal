/** Guest identity: accounts, sessions, handles, recovery, and seats bound to players. */
import { describe, expect, it } from "vitest";
import { type GamePlayerRecord, MeResponse, MyGamesResponse, PlayerProfile, PlayerSession } from "@cabal/protocol";
import { RENAME_COOLDOWN_MS } from "../src/handles.js";
import { SELF } from "cloudflare:test";
import { Client, call, create, createAs, freshHandle, inRoom, join, joinAs, joinRaw, newPlayer, nextIp, serverEnv, start, summary, until } from "./helpers.js";

const db = () => serverEnv.DB!;

describe("guest accounts", () => {
  it("makes a guest with a picked handle and a secret that is stored only as a hash", async () => {
    const guest = await newPlayer();
    expect(guest.player.handle).toMatch(/^[A-Z][a-z]+-\d{4}$/);
    expect(guest.secret).toMatch(/^cps_[0-9a-f]{48}$/);
    const rows = (await db().prepare("SELECT * FROM player_sessions WHERE player_id = ?").bind(guest.player.id).all()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(guest.secret.slice(4));
    const me = MeResponse.parse(await (await call("/api/me", guest.secret)).json());
    expect(me.player).toEqual(guest.player);
    expect(me.rating).toBeNull();
    expect(me.reliability.score).toBeCloseTo(0.9);
    expect(me.trust).toEqual({ score: 0.5, kept: 0, broken: 0, void: 0 });
    expect(me.account).toEqual({ renameAvailableAt: null, recoveryIssuedAt: null, sessions: 1, google: false });
  });

  it("keeps handles unique whatever their case, and refuses reserved and abusive ones", async () => {
    const handle = freshHandle("Talleyrand");
    await newPlayer(handle);
    const post = (h: string) => call("/api/players", null, { method: "POST", body: JSON.stringify({ handle: h }) });
    const taken = await post(handle.toUpperCase());
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "handle_taken" });
    expect(await (await post("Administrator")).json()).toMatchObject({ code: "handle_reserved" });
    expect((await post("Big_Cunt")).status).toBe(400);
    expect((await post("x")).status).toBe(400);
  });

  it("refuses a handle that only reads like one already taken, and a look-alike of the house", async () => {
    const post = (h: string) => call("/api/players", null, { method: "POST", body: JSON.stringify({ handle: h }) });
    const victim = `${freshHandle("Envoy").slice(0, 14)}-ll`;
    await newPlayer(victim);
    for (const impostor of [victim.replace("-", "_"), victim.replace("-ll", "-Il"), victim.replace("-ll", "-1I")]) {
      const res = await post(impostor);
      expect(res.status, impostor).toBe(409);
      expect(await res.json()).toMatchObject({ code: "handle_taken" });
    }
    // The profile answers to any way of writing the handle, and always shows it as it was chosen.
    const profile = PlayerProfile.parse(await (await call(`/api/players/${victim.replace("-ll", "_1i")}`, null)).json());
    expect(profile.player.handle).toBe(victim);
    const house = await post("CabaI-Official");
    expect(house.status).toBe(400);
    expect(await house.json()).toMatchObject({ code: "handle_reserved" });
  });

  it("answers 401 to a missing, malformed or revoked secret, and never treats one as anonymous", async () => {
    expect((await call("/api/me", null)).status).toBe(401);
    expect((await call("/api/me", "cps_" + "0".repeat(48))).status).toBe(401);
    expect((await call("/api/me", "not-a-secret")).status).toBe(401);
    // Creating a game with a dead secret is refused rather than quietly played anonymously.
    const dead = await call("/api/games", "cps_" + "1".repeat(48), { method: "POST", body: JSON.stringify({ name: "Ann" }) });
    expect(dead.status).toBe(401);
    // A name is still all anonymous play needs.
    expect((await call("/api/games", null, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    expect((await create("Anon")).gameId).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("renames freely once, then once every fourteen days, and the old handle keeps pointing here", async () => {
    const guest = await newPlayer();
    const first = freshHandle("Metternich");
    const patch = (handle: string) => call("/api/me", guest.secret, { method: "PATCH", body: JSON.stringify({ handle }) });
    const renamed = await patch(first);
    expect(renamed.status).toBe(200);
    const me = MeResponse.parse(await renamed.json());
    expect(me.player.handle).toBe(first);
    expect(me.account.renameAvailableAt).toBeGreaterThan(Date.now() + RENAME_COOLDOWN_MS - 60_000);
    // Only the case: always allowed.
    expect((await patch(first.toLowerCase())).status).toBe(200);
    const again = await patch(freshHandle("Bismarck"));
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ code: "rename_cooldown" });
    // The picked handle now resolves to the renamed player, and nobody else may take it for a while.
    const profile = PlayerProfile.parse(await (await call(`/api/players/${guest.player.handle}`, null)).json());
    expect(profile.player).toMatchObject({ id: guest.player.id, handle: first.toLowerCase() });
    const squatter = await call("/api/players", null, { method: "POST", body: JSON.stringify({ handle: guest.player.handle }) });
    expect(squatter.status).toBe(409);
    expect((await call("/api/players/NoSuchPlayer9", null)).status).toBe(404);
  });

  it("restores an account on a new device from its recovery code, which a new code replaces", async () => {
    const guest = await newPlayer();
    const issued = await call("/api/me/recovery", guest.secret, { method: "POST" });
    const { recoveryCode } = (await issued.json()) as { recoveryCode: string };
    expect(recoveryCode).toMatch(/^CABAL(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(issued.headers.get("cache-control")).toBe("private, no-store");
    const recover = (code: string) => call("/api/players/recover", null, { method: "POST", body: JSON.stringify({ code }) });
    // However it is typed: lower case, no dashes, O for 0.
    const typed = recoveryCode.toLowerCase().replace(/-/g, " ").replace(/0/g, "o");
    const restored = PlayerSession.parse(await (await recover(typed)).json());
    expect(restored.player).toEqual(guest.player);
    expect(restored.secret).not.toBe(guest.secret);
    // Both devices are signed in.
    expect((await call("/api/me", guest.secret)).status).toBe(200);
    expect(MeResponse.parse(await (await call("/api/me", restored.secret)).json()).account.sessions).toBe(2);
    // A new code retires the old one.
    await call("/api/me/recovery", restored.secret, { method: "POST" });
    expect((await recover(recoveryCode)).status).toBe(401);
    expect((await recover("CABAL-0000-0000-0000-0000-0000")).status).toBe(401);
    expect((await recover("not a code at all")).status).toBe(401);
  });

  it("signs a device out, or every device", async () => {
    const guest = await newPlayer();
    const { recoveryCode } = (await (await call("/api/me/recovery", guest.secret, { method: "POST" })).json()) as { recoveryCode: string };
    const second = PlayerSession.parse(await (await call("/api/players/recover", null, { method: "POST", body: JSON.stringify({ code: recoveryCode }) })).json());
    expect((await call("/api/me/logout", second.secret, { method: "POST" })).status).toBe(204);
    expect((await call("/api/me", second.secret)).status).toBe(401);
    expect((await call("/api/me", guest.secret)).status).toBe(200);
    const third = PlayerSession.parse(await (await call("/api/players/recover", null, { method: "POST", body: JSON.stringify({ code: recoveryCode }) })).json());
    await call("/api/me/logout", third.secret, { method: "POST", body: JSON.stringify({ everywhere: true }) });
    expect((await call("/api/me", guest.secret)).status).toBe(401);
    expect((await call("/api/me", third.secret)).status).toBe(401);
  });
});

describe("seats bound to players", () => {
  it("seats a signed-in player under their handle, once per game, whatever token they hold", async () => {
    const ann = await newPlayer();
    const bob = await newPlayer();
    const game = await createAs(ann.secret);
    const seats = (await summary(game.gameId)).seats;
    expect(seats.find((s) => s.power === game.power)).toMatchObject({ name: ann.player.handle, handle: ann.player.handle });
    // The creator cannot take a second seat, signed in or with the seat token.
    const twice = await joinAs(ann.secret, game.gameId, { name: "Someone else" });
    expect(twice.status).toBe(409);
    expect((await joinRaw(game.gameId, { name: "Again" }, game.token)).status).toBe(409);
    const bobSeat = await joinAs(bob.secret, game.gameId, { name: "ignored" });
    expect(bobSeat.status).toBe(200);
    const { power } = (await bobSeat.json()) as { power: string };
    expect((await summary(game.gameId)).seats.find((s) => s.power === power)).toMatchObject({ name: bob.player.handle, handle: bob.player.handle });
    expect((await joinAs(bob.secret, game.gameId)).status).toBe(409);
    // Anonymous play still works beside them, and anonymous seats have no handle.
    const anon = await join(game.gameId, "Walk-in");
    expect((await summary(game.gameId)).seats.find((s) => s.power === anon.power)?.handle).toBeNull();
  });

  it("gives a signed-in player their seat token again on another device; both tokens work", async () => {
    const ann = await newPlayer();
    const game = await createAs(ann.secret, { aiFill: true });
    await start(game);
    const again = await call(`/api/games/${game.gameId}/seat`, ann.secret, { method: "POST" });
    expect(again.status).toBe(200);
    const second = (await again.json()) as { token: string; power: string };
    expect(second.power).toBe(game.power);
    expect(second.token).not.toBe(game.token);
    const phone = await Client.connect(game.gameId, second.token);
    expect((await phone.next("welcome")).p.power).toBe(game.power);
    const laptop = await Client.connect(game.gameId, game.token);
    expect((await laptop.next("welcome")).p.power).toBe(game.power);
    // Somebody else, or nobody, gets nothing.
    const stranger = await newPlayer();
    expect((await call(`/api/games/${game.gameId}/seat`, stranger.secret, { method: "POST" })).status).toBe(404);
    expect((await call(`/api/games/${game.gameId}/seat`, null, { method: "POST" })).status).toBe(401);
    phone.close();
    laptop.close();
  });

  it("lists a player's own games, live and unlisted ones included", async () => {
    const ann = await newPlayer();
    const game = await createAs(ann.secret);
    const listed = await until(async () => {
      const games = MyGamesResponse.parse(await (await call("/api/me/games", ann.secret)).json()).games;
      return games.find((g) => g.gameId === game.gameId);
    }, "the new game in the player's list");
    expect(listed).toMatchObject({ power: game.power, status: "playing", result: null });
    expect((await call("/api/me/games", null)).status).toBe(401);
  });

  it("records who held each seat, and how reliably, when the game ends", async () => {
    const ann = await newPlayer();
    const bob = await newPlayer();
    const game = await createAs(ann.secret, { aiFill: true });
    const bobSeat = (await (await joinAs(bob.secret, game.gameId)).json()) as { token: string; power: string };
    await start(game);
    const a = await Client.connect(game.gameId, game.token);
    const b = await Client.connect(game.gameId, bobSeat.token);
    const welcome = await a.next("welcome");
    await b.next("welcome");
    // Ann pledges to Bob and keeps it; both order and ready up.
    const units = welcome.p.state.units[game.power]!;
    a.send({ t: "press.send", p: { to: bobSeat.power, body: "I hold.", pledge: { orders: [`${units[0]} H`], sealed: false } } });
    await b.next("press");
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    await a.next("orders.ack");
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const bobUnits = welcome.p.state.units[bobSeat.power]!;
    b.send({ t: "orders.set", p: { phase: "S1901M", orders: bobUnits.map((u) => `${u} H`) } });
    await b.next("orders.ack");
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await a.next("pledge.receipt");
    // The room's record keeps Ann's kept pledge for her stint...
    const stints = await inRoom(game.gameId, (room) => (room as unknown as { playersRecord(): GamePlayerRecord[] }).playersRecord());
    expect(stints.find((p) => p.playerId === ann.player.id)!.ledger).toEqual({ kept: 1, broken: 0, void: 0 });
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    await a.next("finished");
    const record = await until(async () => {
      const r = await inRoom(game.gameId, (room) => room.kv.get("registry-outbox"));
      const indexed = await serverEnv.DB!.prepare("SELECT * FROM game_players WHERE game_id = ? ORDER BY power, stint").bind(game.gameId).all();
      return r === undefined && indexed.results.length === 7 ? indexed.results : null;
    }, "the game's stints in the index");
    const annRow = record.find((r) => r.power === game.power)!;
    // ...but an unlisted one-phase game of two players is below the rated bar, so it reaches no ledger.
    expect(annRow).toMatchObject({ player_id: ann.player.id, kind: "human", status: "finished", phases_due: 1, phases_on_time: 1, kept: 0, broken: 0 });
    expect(record.find((r) => r.power === bobSeat.power)).toMatchObject({ player_id: bob.player.id, phases_due: 1, phases_on_time: 1, kept: 0 });
    expect(record.filter((r) => r.kind === "ai")).toHaveLength(5);
    // Too short and too small a table to be rated, but it is on both records.
    const me = MeResponse.parse(await (await call("/api/me", ann.secret)).json());
    expect(me.rating).toBeNull();
    expect(me.games.played).toBe(1);
    expect(me.trust).toMatchObject({ kept: 0, broken: 0 });
    expect(me.reliability).toMatchObject({ phasesDue: 1, phasesOnTime: 1, missed: 0 });
    // Unlisted: the owner sees the game, a stranger sees that a game was played but not its code.
    expect(me.recent[0]).toMatchObject({ gameId: game.gameId, result: "draw", ratingDelta: null });
    const publicProfile = PlayerProfile.parse(await (await call(`/api/players/${ann.player.handle}`, null)).json());
    expect(publicProfile.recent.some((r) => r.gameId === game.gameId)).toBe(false);
    expect(publicProfile.games.played).toBe(1);
    a.close();
    b.close();
  });
});

describe("abuse limits", () => {
  it("limits account creation and recovery attempts per address, and account changes per player", async () => {
    const ip = nextIp();
    const make = () => SELF.fetch("http://cabal/api/players", { method: "POST", headers: { "cf-connecting-ip": ip }, body: "{}" });
    const made: number[] = [];
    for (let i = 0; i < 12; i++) made.push((await make()).status);
    expect(made.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(made.slice(10)).toEqual([429, 429]);
    const guessIp = nextIp();
    const guesses: number[] = [];
    for (let i = 0; i < 12; i++) {
      guesses.push((await SELF.fetch("http://cabal/api/players/recover", { method: "POST", headers: { "cf-connecting-ip": guessIp }, body: JSON.stringify({ code: "CABAL-0000-0000-0000-0000-0000" }) })).status);
    }
    expect(guesses.at(-1)).toBe(429);
    const guest = await newPlayer();
    const changes: number[] = [];
    for (let i = 0; i < 22; i++) changes.push((await call("/api/me/recovery", guest.secret, { method: "POST" })).status);
    expect(changes.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(changes.at(-1)).toBe(429);
  });

  it("refuses an oversized body before reading it", async () => {
    const res = await call("/api/players", null, { method: "POST", body: JSON.stringify({ handle: "x".repeat(10_000) }) });
    expect(res.status).toBe(400);
  });
});

describe("seats bound to players, when they change hands", () => {
  it("never lets a player who left a seat come back as a substitute, and records both stints", async () => {
    const [ann, bob, cat] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    const game = await createAs(ann.secret, { aiFill: true });
    const bobSeat = (await (await joinAs(bob.secret, game.gameId)).json()) as { token: string; power: string };
    await start(game);
    // Bob has been gone for four movement phases: his seat is vacant.
    await inRoom(game.gameId, (room) => {
      room.sql.exec("UPDATE seats SET kind = 'civil_disorder', missed = 4 WHERE power = ?", bobSeat.power);
    });
    const issued = await call(`/api/games/${game.gameId}/substitute`, null, {
      method: "POST",
      headers: { authorization: `Bearer ${game.token}` },
      body: JSON.stringify({ power: bobSeat.power }),
    });
    const { invite } = (await issued.json()) as { invite: string };
    // Bob, signed in, cannot take the seat back as somebody else, nor can Ann take a second one.
    expect((await joinAs(bob.secret, game.gameId, { invite })).status).toBe(409);
    expect((await joinAs(ann.secret, game.gameId, { invite })).status).toBe(409);
    const taken = await joinAs(cat.secret, game.gameId, { invite });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { power: string }).power).toBe(bobSeat.power);
    const stints = await inRoom(game.gameId, (room) =>
      room.sql.exec<{ stint: number; player_id: string; substitute: number; left_reason: string | null }>("SELECT * FROM stints WHERE power = ? ORDER BY stint", bobSeat.power).toArray(),
    );
    expect(stints).toMatchObject([
      { stint: 0, player_id: bob.player.id, substitute: 0, left_reason: "replaced" },
      { stint: 1, player_id: cat.player.id, substitute: 1, left_reason: null },
    ]);
    // Bob's own list says he left; Cat's says she is playing.
    const bobGames = await until(async () => {
      const games = MyGamesResponse.parse(await (await call("/api/me/games", bob.secret)).json()).games;
      return games.find((g) => g.gameId === game.gameId && g.status === "left");
    }, "Bob's game to show as left");
    expect(bobGames.power).toBe(bobSeat.power);
    const catGames = await until(async () => MyGamesResponse.parse(await (await call("/api/me/games", cat.secret)).json()).games.find((g) => g.gameId === game.gameId), "Cat's game");
    expect(catGames.status).toBe("playing");
  });

  it("ignores a player a client names in the body: only the router says who a player is", async () => {
    const victim = await newPlayer();
    const game = await create("Ann");
    const res = await joinRaw(game.gameId, { name: "Mallory", player: { id: victim.player.id, handle: victim.player.handle } });
    expect(res.status).toBe(200);
    const { power } = (await res.json()) as { power: string };
    const seat = (await summary(game.gameId)).seats.find((s) => s.power === power)!;
    expect(seat).toMatchObject({ name: "Mallory", handle: null });
    expect(await inRoom(game.gameId, (room) => room.sql.exec<{ player_id: string | null }>("SELECT player_id FROM seats WHERE power = ?", power).one().player_id)).toBeNull();
  });
});
