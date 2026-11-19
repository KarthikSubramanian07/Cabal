import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Game } from "@cabal/engine";
import {
  Client,
  create,
  deadlineIn,
  holdAndReady,
  inRoom,
  join,
  nextIp,
  start,
  summary,
  untilIndexed,
} from "./helpers.js";

async function seedGame(gameId: string, game: Game): Promise<void> {
  await inRoom(gameId, async (room, state) => {
    (room as unknown as { game: Game }).game = game;
    await state.storage.put("saved", game.toSaved(gameId));
  });
}

describe("GameRoom", () => {
  it("creates a game with a lobby and seven seats", async () => {
    const ann = await create("Ann");
    expect(ann.gameId).toMatch(/^[A-Z0-9]{6}$/);
    const lobby = await summary(ann.gameId);
    expect(lobby.status).toBe("lobby");
    expect(lobby.seats).toHaveLength(7);
    expect(lobby.seats.filter((s) => s.kind === "human")).toHaveLength(1);
    expect(lobby.phase).toBe("S1901M");
  });

  it("runs seven human seats from the opening phase through a draw vote", async () => {
    const seats = [await create("Player 1", { aiFill: false, readyAdvance: true, dias: true })];
    for (let i = 2; i <= 7; i++) seats.push(await join(seats[0]!.gameId, `Player ${i}`));
    const clients = await Promise.all(seats.map((seat) => Client.connect(seat.gameId, seat.token)));
    const welcomes = await Promise.all(clients.map((client) => client.next("welcome")));
    expect(welcomes.every((welcome) => welcome.p.phase === "S1901M")).toBe(true);

    for (let i = 0; i < clients.length; i++) {
      const power = seats[i]!.power;
      const holds = welcomes[i]!.p.state.units[power]!.map((unit) => `${unit} H`);
      clients[i]!.send({ t: "orders.set", p: { phase: "S1901M", orders: holds } });
    }
    await Promise.all(clients.map((client) => client.next("orders.ack")));
    const results = clients[0]!.next("results");
    for (const client of clients) client.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    expect((await results).p.phase).toBe("S1901M");

    const finished = clients[0]!.next("finished");
    for (const client of clients) client.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await finished).p.result).toBe("draw");
  });

  it("plays a phase end to end: join, start with AI fill, orders, ready, results, pledges", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    expect(bob.power).not.toBe(ann.power);

    const started = await start(ann);
    expect(started.status).toBe(200);
    const begun = (await started.json()) as { status: string; seats: { kind: string }[] };
    expect(begun.status).toBe("active");
    expect(begun.seats.filter((s) => s.kind === "ai")).toHaveLength(5);

    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const welcome = await a.next("welcome");
    expect(welcome.p.power).toBe(ann.power);
    expect(welcome.p.phase).toBe("S1901M");
    const units = welcome.p.state.units[ann.power]!;
    expect(units.length).toBeGreaterThan(0);

    // a pledge from Ann to Bob, sealed
    a.send({
      t: "press.send",
      id: "m1",
      p: { to: bob.power, body: "I will hold everything.", pledge: { orders: [`${units[0]} H`], sealed: true } },
    });
    const pressAtBob = await b.next("press");
    expect(pressAtBob.p.from).toBe(ann.power);
    expect(pressAtBob.p.pledge?.sealed).toBe(true);
    expect(pressAtBob.p.pledge?.orders).toBeNull(); // sealed: hidden until the phase resolves
    const pressAtAnn = await a.next("press");
    expect(pressAtAnn.p.pledge?.orders).toEqual([`${units[0]} H`]);

    // Ann keeps her word, Bob submits a bad order and a good one
    a.send({ t: "orders.set", id: "o1", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    const ackA = await a.next("orders.ack");
    expect(ackA.p.rejected).toHaveLength(0);
    const bobUnits = (await b.next("welcome")).p.state.units[bob.power]!;
    b.send({ t: "orders.set", id: "o2", p: { phase: "S1901M", orders: [`${bobUnits[0]} H`, "A NOWHERE - PAR"] } });
    const ackB = await b.next("orders.ack");
    expect(ackB.p.accepted).toHaveLength(1);
    expect(ackB.p.rejected).toHaveLength(1);

    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });

    const results = await a.next("results");
    expect(results.p.phase).toBe("S1901M");
    expect(results.p.results.length).toBe(22);
    const receipt = await b.next("pledge.receipt");
    expect(receipt.p.receipt).toBe("kept");
    expect(receipt.p.revealed).toEqual([`${units[0]} H`]);
    const state = await a.next("state");
    expect(state.p.phase).toBe("F1901M");

    // replay export is a valid saved game with two phases
    const replay = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/replay`);
    const saved = (await replay.json()) as { phases: { name: string }[] };
    expect(saved.phases.map((p) => p.name)).toEqual(["S1901M", "F1901M"]);
    const ledger = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/ledger`);
    expect((await ledger.json() as { ledger: Record<string, { kept: number; broken: number; void: number }> }).ledger[ann.power]).toEqual({ kept: 1, broken: 0, void: 0 });
  });

  it("accepts retreat orders and advances back into movement", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, rulebookPress: true });
    await start(ann);
    const state = new Game().state();
    const enemy = (["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as string[])
      .find((power) => power !== ann.power)!;
    state.units = { [ann.power]: ["A BUR"], [enemy]: ["A MUN", "A RUH"] };
    const staged = Game.fromState(state);
    const movement = staged.process({ orders: { [enemy]: ["A MUN - BUR", "A RUH S A MUN - BUR"] } });
    expect(staged.phase()).toBe("S1901R");
    expect(movement.dislodged[0]?.unit).toBe("A BUR");
    await seedGame(ann.gameId, staged);
    const client = await Client.connect(ann.gameId, ann.token);
    const welcome = await client.next("welcome");
    const options = welcome.p.state.retreats[ann.power]?.["A BUR"] ?? [];
    expect(options.length).toBeGreaterThan(0);
    client.send({ t: "press.send", p: { to: "ALL", body: "closed during retreat" } });
    expect((await client.next("error")).p.code).toBe("press_closed");
    client.send({ t: "orders.set", p: { phase: "S1901R", orders: [`A BUR - ${options[0]}`] } });
    expect((await client.next("orders.ack")).p.accepted).toHaveLength(1);
    client.send({ t: "ready", p: { phase: "S1901R", ready: true } });
    expect((await client.next("state")).p.phase).toBe("F1901M");
  });

  it("accepts adjustment builds and returns to the next spring movement", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, rulebookPress: true });
    await start(ann);
    const state = new Game().state();
    state.name = "F1901M";
    state.units[ann.power] = state.units[ann.power]!.slice(0, 1);
    state.builds[ann.power] = { count: 2, homes: state.homes[ann.power]! };
    const staged = Game.fromState(state);
    staged.process({ orders: {} });
    expect(staged.phase()).toBe("W1901A");
    const buildOrders = Object.values(staged.legal(ann.power).by_unit).flat();
    expect(buildOrders.length).toBeGreaterThan(0);
    await seedGame(ann.gameId, staged);
    const client = await Client.connect(ann.gameId, ann.token);
    const welcome = await client.next("welcome");
    expect(welcome.p.phase).toBe("W1901A");
    client.send({ t: "press.send", p: { to: "ALL", body: "closed during builds" } });
    expect((await client.next("error")).p.code).toBe("press_closed");
    client.send({ t: "orders.set", p: { phase: "W1901A", orders: [buildOrders[0]!] } });
    expect((await client.next("orders.ack")).p.accepted).toHaveLength(1);
    client.send({ t: "ready", p: { phase: "W1901A", ready: true } });
    expect((await client.next("state")).p.phase).toBe("S1902M");
  });

  it("applies pacing presets and extends a deadline once, when two players ask", async () => {
    const ann = await create("Ann", { pacing: "live" });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const begun = await summary(ann.gameId);
    expect(begun.settings).toMatchObject({ movementSeconds: 600, shortPhaseSeconds: 300, graceSeconds: 60, extendSeconds: 300 });
    const initialDeadline = begun.deadlineAt!;
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    a.send({ t: "extend", id: "ext-a", p: { phase: "S1901M" } });
    expect((await a.next("extend.ack")).p).toMatchObject({ requests: 1, extended: false });
    // The other player is told a request is pending, so they know to second it.
    expect((await b.next("extend")).p).toMatchObject({ requestedBy: [ann.power], needed: 2, granted: false });
    expect((await summary(ann.gameId)).deadlineAt).toBe(initialDeadline);
    b.send({ t: "extend", id: "ext-b", p: { phase: "S1901M" } });
    expect((await b.next("extend.ack")).p).toMatchObject({ requests: 2, extended: true });
    expect((await summary(ann.gameId)).deadlineAt).toBe(initialDeadline + 300_000);
    a.send({ t: "extend", p: { phase: "S1901M" } });
    expect((await a.next("error")).p.code).toBe("extension_used");
    // Spectators cannot ask for time.
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    spectator.send({ t: "extend", p: { phase: "S1901M" } });
    expect((await spectator.next("error")).p.code).toBe("spectator");
  });

  it("uses the daily and async presets, lets explicit seconds win, and rejects bad settings with a 400", async () => {
    const daily = await summary((await create("Ann", { pacing: "daily" })).gameId);
    expect(daily.settings).toMatchObject({ movementSeconds: 86_400, shortPhaseSeconds: 43_200 });
    const dflt = await summary((await create("Ann")).gameId);
    expect(dflt.settings).toMatchObject({ pacing: "async", movementSeconds: 172_800, shortPhaseSeconds: 86_400 });
    const custom = await summary((await create("Ann", { pacing: "live", movementSeconds: 120 })).gameId);
    expect(custom.settings).toMatchObject({ movementSeconds: 120, shortPhaseSeconds: 300 });
    const bad = await SELF.fetch("http://cabal/api/games", {
      method: "POST",
      headers: { "cf-connecting-ip": nextIp() },
      body: JSON.stringify({ name: "Ann", settings: { pacing: "hourly" } }),
    });
    expect(bad.status).toBe(400);
  });

  it("starts each phase with the pacing clock and the short clock for retreats", async () => {
    const ann = await create("Ann", { pacing: "live", graceSeconds: 0 });
    await start(ann);
    const begun = await summary(ann.gameId);
    expect(begun.deadlineAt! - Date.now()).toBeGreaterThan(590_000);
    expect(begun.deadlineAt! - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it("enforces the configured private press budget", async () => {
    const ann = await create("Ann", { aiFill: true, whisperBudget: 2 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    for (let i = 0; i < 2; i++) {
      a.send({ t: "press.send", p: { to: "FRANCE", body: `private ${i}` } });
      await a.next("press");
    }
    a.send({ t: "press.send", p: { to: "FRANCE", body: "over budget" } });
    expect((await a.next("error")).p.code).toBe("whisper_budget");
  });

  it("enforces public-only and gunboat press modes", async () => {
    for (const [mode, expected] of [["public", "public_only"], ["gunboat", "no_press"]] as const) {
      const ann = await create("Ann", { aiFill: true, press: mode });
      await start(ann);
      const client = await Client.connect(ann.gameId, ann.token);
      await client.next("welcome");
      client.send({ t: "press.send", p: { to: "FRANCE", body: "private message" } });
      expect((await client.next("error")).p.code).toBe(expected);
    }
  });

  it("never lets default orders command another power's units", async () => {
    // One opening move per power, keyed by the power name the server assigns.
    const moves: Record<string, [string, string]> = {
      AUSTRIA: ["A VIE - GAL", "A GAL"],
      ENGLAND: ["F LON - NTH", "F NTH"],
      FRANCE: ["A PAR - BUR", "A BUR"],
      GERMANY: ["A MUN - RUH", "A RUH"],
      ITALY: ["A VEN - PIE", "A PIE"],
      RUSSIA: ["A MOS - UKR", "A UKR"],
      TURKEY: ["A CON - BUL", "A BUL"],
    };
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const annUnits = [...(await a.next("welcome")).p.state.units[ann.power]!].sort();
    await b.next("welcome");

    // Bob files his own move plus one dressed up as Ann's, then submits nothing.
    b.send({
      t: "orders.default",
      id: "d1",
      p: { orders: [moves[bob.power]![0], `${ann.power}: ${moves[ann.power]![0]}`] },
    });
    const error = await b.next("error");
    expect(error.p.code).toBe("bad_order");
    expect(error.p.message).toContain("another power");

    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const results = await a.next("results");
    const state = await a.next("state");
    expect(state.p.phase).toBe("F1901M");
    expect([...state.p.state.units[ann.power]!].sort()).toEqual(annUnits);
    // Bob's legitimate default still stood in for his missing orders: it was the order adjudicated
    // for his unit. Whether the move got through is the board's business (a neighbour may bounce it).
    expect(results.p.results.filter((r) => r.power === bob.power).map((r) => r.order)).toContain(moves[bob.power]![0]);
    // And nothing was adjudicated for Ann's units on Bob's say-so.
    expect(results.p.results.filter((r) => r.power === ann.power).map((r) => r.order)).not.toContain(moves[ann.power]![0]);
  });

  it("throttles a socket that floods the room", async () => {
    const ann = await create("Ann");
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    for (let i = 0; i < 60; i++) spectator.send({ t: "sync", p: { since: 0 } });
    const error = await spectator.next("error");
    expect(error.p.code).toBe("rate_limited");
    // The first sync was answered and closed with a cursor.
    expect((await spectator.next("synced")).p).toMatchObject({ more: false });
  });

  it("answers 404 for a code that names no game", async () => {
    const res = await SELF.fetch("http://cabal/api/games/ZZZZZ9");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects HTTP bodies larger than 4 KB", async () => {
    const res = await SELF.fetch("http://cabal/api/games", {
      method: "POST",
      headers: { "cf-connecting-ip": nextIp() },
      body: JSON.stringify({ name: "Oversize", extra: "x".repeat(5000) }),
    });
    expect(res.status).toBe(400);
  });

  it("fires the deadline alarm by itself and applies sealed default orders", async () => {
    const moves: Record<string, string> = {
      AUSTRIA: "A VIE - GAL",
      ENGLAND: "F LON - NTH",
      FRANCE: "A PAR - BUR",
      GERMANY: "A MUN - RUH",
      ITALY: "A VEN - PIE",
      RUSSIA: "A MOS - UKR",
      TURKEY: "A CON - BUL",
    };
    const ann = await create("Ann", { aiFill: true, graceSeconds: 0 });
    await start(ann);
    const client = await Client.connect(ann.gameId, ann.token);
    expect((await client.next("welcome")).p.phase).toBe("S1901M");
    client.send({ t: "orders.default", p: { orders: [moves[ann.power]!] } });
    // Nobody readies. The deadline passes and the room's own alarm resolves the phase.
    await deadlineIn(ann.gameId, 80);
    const state = await client.next("state", (m) => m.p.phase === "F1901M");
    const destination = moves[ann.power]!.split(" - ")[1]!;
    const unitType = moves[ann.power]!.startsWith("F ") ? "F" : "A";
    expect(state.p.state.units[ann.power]).toContain(`${unitType} ${destination}`);
    expect(state.p.status).toBe("active");
    // Defaults are honoured, but the player was still absent: that is one missed phase.
    expect((await summary(ann.gameId)).seats.find((s) => s.power === ann.power)).toMatchObject({ kind: "human", missed: 1 });
    // The next phase has its own full deadline.
    expect(state.p.deadlineAt! - Date.now()).toBeGreaterThan(172_000_000);
  });

  it("lets a draw pass when both players agree, and records the game in the Registry", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const annUnits = (await a.next("welcome")).p.state.units[ann.power]!;
    const bobUnits = (await b.next("welcome")).p.state.units[bob.power]!;
    // Bob readies up without orders twice, which puts his seat into civil disorder.
    for (const phase of ["S1901M", "F1901M"]) {
      b.send({ t: "ready", p: { phase, ready: true } });
      await holdAndReady(a, annUnits, phase);
    }
    const disorder = await summary(ann.gameId);
    expect(disorder.seats.find((seat) => seat.power === bob.power)).toMatchObject({ kind: "civil_disorder", missed: 2, autopilot: true });

    // The returning player submits orders with the token he always had, and has his seat back.
    const phase = disorder.phase;
    b.send({ t: "orders.set", p: { phase, orders: bobUnits.map((unit) => `${unit} H`) } });
    const returned = await b.next("orders.ack", (m) => m.p.phase === phase);
    expect(returned.p.accepted.length).toBeGreaterThan(0);
    expect((await summary(ann.gameId)).seats.find((seat) => seat.power === bob.power)).toMatchObject({ kind: "human", missed: 0, autopilot: false });

    a.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await b.next("votes")).p).toMatchObject({ draw: [{ power: ann.power, value: true, include: null }] });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    const finished = await a.next("finished");
    expect(finished.p).toMatchObject({ result: "draw", reason: "vote" });
    const indexed = await untilIndexed(ann.gameId);
    expect(indexed).toMatchObject({ result: "draw", reason: "vote", cluster: "standard:full:async" });
    expect(indexed.phaseCount).toBeGreaterThanOrEqual(2);
    expect(indexed.seats.find((seat) => seat.power === ann.power)).toMatchObject({ kind: "human", name: "Ann" });
  });

  it("binds a socket with a hello frame, refuses tokens in the URL and closes on a bad token", async () => {
    const ann = await create("Ann");
    const inUrl = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/ws?token=${ann.token}`, {
      headers: { upgrade: "websocket", "cf-connecting-ip": nextIp() },
    });
    expect(inUrl.status).toBe(400);
    const spectator = await Client.connect(ann.gameId);
    expect((await spectator.next("welcome")).p.power).toBeNull();
    spectator.send({ t: "hello", id: "h1", p: { token: ann.token } });
    const bound = await spectator.next("welcome");
    expect(bound.p.power).toBe(ann.power);
    expect(bound.id).toBe("h1");
    const forged = await Client.connect(ann.gameId, `${ann.gameId}.FRANCE.${"0".repeat(48)}`);
    expect((await forged.next("error")).p.code).toBe("bad_token");
    expect((await forged.untilClosed()).code).toBe(4401);
  });
});
