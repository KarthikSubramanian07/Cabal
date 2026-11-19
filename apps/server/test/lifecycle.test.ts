/**
 * Lifecycle regression tests.
 *
 * Most of these began as the adversarial probes written against the first version of this room
 * (labelled A1 to A11 and C1 to C3 after the review that found them). Each asserts the correct
 * behaviour and failed before the fix it guards.
 */
import { describe, expect, it } from "vitest";
import { Game } from "@cabal/engine";
import {
  Client,
  POWERS,
  type Seat,
  create,
  deadlineIn,
  fireAlarm,
  holdAndReady,
  inRoom,
  inviteSubstitute,
  join,
  joinRaw,
  sleep,
  sql,
  start,
  stubOf,
  summary,
  until,
  untilIndexed,
  untilPhase,
  untilStatus,
} from "./helpers.js";

const seatOf = async (gameId: string, power: string) => (await summary(gameId)).seats.find((s) => s.power === power)!;
const phaseCount = async (gameId: string) => (await sql<{ n: number }>(gameId, "SELECT COUNT(*) AS n FROM phases"))[0]!.n;

/**
 * Ann and Bob with five AI seats. Ann holds and readies through `misses` movement phases while Bob
 * readies with no orders (or says nothing at all once his seat is in civil disorder).
 */
async function bobGoesMissing(misses: number, settings: Record<string, unknown> = {}) {
  const ann = await create("Ann", { aiFill: true, readyAdvance: true, ...settings });
  const bob = await join(ann.gameId, "Bob");
  await start(ann);
  const a = await Client.connect(ann.gameId, ann.token);
  const b = await Client.connect(ann.gameId, bob.token);
  const annUnits = (await a.next("welcome")).p.state.units[ann.power]!;
  const bobUnits = (await b.next("welcome")).p.state.units[bob.power]!;
  let phase = "S1901M";
  for (let i = 0; i < misses; i++) {
    if (i < 2) b.send({ t: "ready", p: { phase, ready: true } });
    phase = (await holdAndReady(a, annUnits, phase)).p.phase;
  }
  return { ann, bob, a, b, annUnits, bobUnits, phase };
}

describe("ready-advance", () => {
  it("A4: with no human left playing, nothing an AI seat does can resolve a phase", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const ai = (await summary(ann.gameId)).seats.find((s) => s.kind === "ai")!;
    // Every AI seat already has its orders in and is ready.
    expect((await summary(ann.gameId)).seats.filter((s) => s.kind === "ai").every((s) => s.ready)).toBe(true);
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2 WHERE kind = 'human'");
    const result = await stubOf(ann.gameId).agentSubmit(ai.power as "FRANCE", "S1901M", "order", { orders: [], messages: [], pledge: null }, { model: null, usage: null, billed: "no" });
    expect(result.applied).toBe(false);
    await inRoom(ann.gameId, (room) => {
      room.advance();
      room.settle();
    });
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    expect(await phaseCount(ann.gameId)).toBe(0);
  });

  it("waits for every seat that can act, and AI seats have always moved before a human can advance", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    // All five AI seats put real orders on file the moment the phase opened.
    const botRows = await sql<{ power: string; orders_json: string }>(ann.gameId, "SELECT power, orders_json FROM orders WHERE phase = 'S1901M' AND source = 'bot'");
    expect(botRows).toHaveLength(5);
    for (const row of botRows) expect((JSON.parse(row.orders_json) as string[]).length).toBeGreaterThanOrEqual(3);
    // Ann alone being ready is not enough: Bob can act and has not said so.
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await a.next("seats", (m) => m.p.seats.some((s) => s.power === ann.power && s.ready));
    await sleep(60);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    const b = await Client.connect(ann.gameId, bob.token);
    await b.next("welcome");
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const results = await a.next("results");
    // The AI seats' orders were adjudicated, not skipped.
    for (const row of botRows) {
      expect(results.p.results.filter((r) => r.power === row.power).map((r) => r.order).sort()).toEqual((JSON.parse(row.orders_json) as string[]).sort());
    }
  });

  it("tells a client its ready was for a phase that has already resolved", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    a.send({ t: "ready", id: "r", p: { phase: "F1901M", ready: true } });
    expect((await a.next("error")).p.code).toBe("stale_phase");
  });
});

describe("games nobody is playing", () => {
  it("A11: a game whose only human is gone is driven by its deadline alone, and is then abandoned", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2 WHERE kind = 'human'");
    // One ordinary deadline. Before the fix this set off hundreds of phases with nobody present.
    await deadlineIn(ann.gameId, 40);
    await untilPhase(ann.gameId, "F1901M");
    await sleep(1200);
    expect(await phaseCount(ann.gameId)).toBe(1);
    expect((await summary(ann.gameId)).status).toBe("active");
    // It keeps to its deadlines, and after three movement phases without a human order it ends.
    for (let i = 0; i < 12 && (await summary(ann.gameId)).status === "active"; i++) {
      const before = await phaseCount(ann.gameId);
      await deadlineIn(ann.gameId, 30);
      await until(async () => (await phaseCount(ann.gameId)) > before, "the deadline to resolve the phase");
    }
    const ended = await summary(ann.gameId);
    expect(ended.status).toBe("abandoned");
    expect(ended.finished).toMatchObject({ result: "abandoned", reason: "no_orders", winners: [] });
    expect(ended.deadlineAt).toBeNull();
    expect((await a.next("finished")).p).toMatchObject({ result: "abandoned", reason: "no_orders" });
    expect((await a.next("status", (m) => m.p.status === "abandoned")).p.reason).toBe("no_orders");
    // Three idle movement phases, plus whatever bot-only builds fell between them.
    const movementPhases = (await sql<{ name: string }>(ann.gameId, "SELECT name FROM phases")).filter((p) => p.name.endsWith("M"));
    expect(movementPhases).toHaveLength(3);
    // Abandoned games are indexed too, and the room then goes quiet for good.
    expect(await untilIndexed(ann.gameId)).toMatchObject({ result: "abandoned", reason: "no_orders", winners: [] });
    await until(async () => (await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())) === null, "the alarm to clear");
  });

  it("an idle human who stays connected still falls into civil disorder and the game still ends", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true, graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const kinds: string[] = [];
    for (let i = 0; i < 12 && (await summary(ann.gameId)).status === "active"; i++) {
      const before = await phaseCount(ann.gameId);
      await deadlineIn(ann.gameId, 30);
      await until(async () => (await phaseCount(ann.gameId)) > before, "the deadline to resolve the phase");
      kinds.push((await seatOf(ann.gameId, ann.power)).kind);
    }
    expect(kinds[0]).toBe("human");
    expect(kinds).toContain("civil_disorder");
    expect((await summary(ann.gameId)).status).toBe("abandoned");
    expect(await phaseCount(ann.gameId)).toBeLessThanOrEqual(6);
  });

  it("finishes the game when no human power survives on the board", async () => {
    const ann = await create("Ann", { aiFill: true, graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const state = new Game().state();
    state.units[ann.power] = [];
    state.centers[ann.power] = [];
    const staged = Game.fromState(state);
    await inRoom(ann.gameId, async (room, storage) => {
      (room as unknown as { game: Game }).game = staged;
      await storage.storage.put("saved", staged.toSaved(ann.gameId));
    });
    await deadlineIn(ann.gameId, 30);
    const finished = await a.next("finished");
    expect(finished.p).toMatchObject({ result: "draw", reason: "no_humans_left" });
    expect(finished.p.winners).not.toContain(ann.power);
    expect((await summary(ann.gameId)).status).toBe("finished");
  });

  it("closes a lobby that nobody ever starts", async () => {
    const ann = await create("Ann");
    const armed = await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm());
    expect(armed! - Date.now()).toBeGreaterThan(6 * 24 * 3600_000);
    await inRoom(ann.gameId, (room) => {
      (room.meta as unknown as { createdAt: number }).createdAt = Date.now() - 8 * 24 * 3600_000;
    });
    expect(await fireAlarm(ann.gameId)).toBe(true);
    expect(await summary(ann.gameId)).toMatchObject({ status: "abandoned", finished: { reason: "lobby_expired" } });
  });
});

describe("pausing", () => {
  it("A1: a live game pauses when every human leaves and resumes with exactly the time that was left", async () => {
    const ann = await create("Ann", { aiFill: true, pacing: "live", graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    // Twenty seconds left on a ten minute clock.
    await deadlineIn(ann.gameId, 20_000);
    a.close();
    const paused = await untilStatus(ann.gameId, "paused");
    expect(paused).toMatchObject({ pauseReason: "humans_absent", deadlineAt: null });
    expect(paused.pausedRemainingMs).toBeGreaterThan(10_000);
    expect(paused.pausedRemainingMs).toBeLessThanOrEqual(20_000);
    // The pause is bounded: it names the moment it ends by itself.
    expect(paused.pausedUntil! - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(paused.pausedUntil! - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect((await spectator.next("status", (m) => m.p.status === "paused")).p).toMatchObject({ reason: "humans_absent", until: paused.pausedUntil });
    await sleep(300);
    const again = await Client.connect(ann.gameId, ann.token);
    expect((await again.next("welcome")).p.status).toBe("active");
    const resumed = await summary(ann.gameId);
    expect(resumed.status).toBe("active");
    // Not a fresh ten minutes: what was left when the clock stopped, and not a millisecond more.
    expect(resumed.deadlineAt! - Date.now()).toBeLessThanOrEqual(paused.pausedRemainingMs!);
    expect(resumed.deadlineAt! - Date.now()).toBeGreaterThan(paused.pausedRemainingMs! - 8_000);
  });

  it("a pause ends by itself, and the game then runs on with the time that was left", async () => {
    const ann = await create("Ann", { aiFill: true, pacing: "live", graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    await deadlineIn(ann.gameId, 60_000);
    a.close();
    await untilStatus(ann.gameId, "paused");
    // Bring the pause limit close; the room's own alarm ends the pause.
    await inRoom(ann.gameId, (room) => {
      room.meta.pause!.until = Date.now() + 60;
      room.kv.put("meta", room.meta);
      room.rearm();
    });
    const resumed = await untilStatus(ann.gameId, "active");
    expect(resumed.deadlineAt! - Date.now()).toBeGreaterThan(55_000);
    expect(resumed.deadlineAt! - Date.now()).toBeLessThanOrEqual(60_000);
    // Nobody came back, so the deadline does its job and the absent player takes a miss.
    await deadlineIn(ann.gameId, 30);
    await untilPhase(ann.gameId, "F1901M");
    expect(await seatOf(ann.gameId, ann.power)).toMatchObject({ missed: 1 });
  });

  it("a phase cannot be stalled by pausing over and over", async () => {
    const ann = await create("Ann", { aiFill: true, pacing: "live" });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    // This phase has already used its whole pause allowance.
    await inRoom(ann.gameId, (room) => {
      (room.meta as unknown as { pausedMsThisPhase: number }).pausedMsThisPhase = 10 * 60_000;
      room.kv.put("meta", room.meta);
    });
    a.close();
    await sleep(150);
    expect((await summary(ann.gameId)).status).toBe("active");
  });

  it("daily and async games never pause: a closed tab is not absence", async () => {
    for (const pacing of ["daily", "async"]) {
      const ann = await create("Ann", { aiFill: true, pacing });
      await start(ann);
      const a = await Client.connect(ann.gameId, ann.token);
      await a.next("welcome");
      const before = await summary(ann.gameId);
      a.close();
      await sleep(150);
      const after = await summary(ann.gameId);
      expect(after.status).toBe("active");
      expect(after.deadlineAt).toBe(before.deadlineAt);
    }
  });

  it("A9: a spectator coming or going never pauses a game, even a live one with its player away", async () => {
    const ann = await create("Ann", { aiFill: true, pacing: "live" });
    await start(ann);
    const before = await summary(ann.gameId);
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    spectator.close();
    await sleep(150);
    const after = await summary(ann.gameId);
    expect(after.status).toBe("active");
    expect(after.deadlineAt).toBe(before.deadlineAt);
  });
});

describe("spectators", () => {
  it("cannot order, ready, vote, extend or send press, and leave no trace on the game", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const before = await summary(ann.gameId);
    const spectator = await Client.connect(ann.gameId);
    const welcome = await spectator.next("welcome");
    const frames = [
      { t: "orders.set", p: { phase: "S1901M", orders: [`${welcome.p.state.units[ann.power]![0]} H`] } },
      { t: "orders.default", p: { orders: ["A PAR - BUR"] } },
      { t: "ready", p: { phase: "S1901M", ready: true } },
      { t: "extend", p: { phase: "S1901M" } },
      { t: "press.send", p: { to: "ALL", body: "let me in" } },
      { t: "vote", p: { kind: "draw", value: true } },
    ];
    for (const frame of frames) {
      spectator.send(frame);
      expect((await spectator.next("error")).p.code).toBe("spectator");
    }
    expect(await summary(ann.gameId)).toEqual(before);
    expect(await sql(ann.gameId, "SELECT * FROM orders WHERE source = 'human'")).toHaveLength(0);
    expect(await sql(ann.gameId, "SELECT * FROM votes")).toHaveLength(0);
    expect(await sql(ann.gameId, "SELECT * FROM press")).toHaveLength(0);
    expect(await sql(ann.gameId, "SELECT * FROM defaults")).toHaveLength(0);
  });
});

describe("civil disorder, cover and substitutes", () => {
  it("covers a seat in civil disorder with the bot, and its player takes it back by ordering", async () => {
    const { ann, bob, a, b, bobUnits, phase } = await bobGoesMissing(2);
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "civil_disorder", missed: 2, autopilot: true, name: "Bob" });
    // The bot is playing Bob's units this phase, so the seat is not just holding.
    const cover = await sql<{ source: string; orders_json: string }>(ann.gameId, "SELECT source, orders_json FROM orders WHERE phase = ? AND power = ?", phase, bob.power);
    expect(cover[0]!.source).toBe("bot");
    expect((JSON.parse(cover[0]!.orders_json) as string[]).length).toBeGreaterThan(0);
    // A seat in civil disorder cannot ready or vote: its player has to come back first.
    b.send({ t: "ready", p: { phase, ready: true } });
    expect((await b.next("error")).p.code).toBe("seat_inactive");
    // Bob's token was never touched. He orders, and the seat is his again.
    const current = (await summary(ann.gameId)).phase;
    b.send({ t: "orders.set", p: { phase: current, orders: bobUnits.map((u) => `${u} H`) } });
    await b.next("orders.ack", (m) => m.p.phase === current);
    expect((await a.next("seats", (m) => m.p.seats.some((s) => s.power === bob.power && s.kind === "human"))).p.seats.find((s) => s.power === bob.power)).toMatchObject({
      kind: "human",
      missed: 0,
      autopilot: false,
    });
    const mine = await sql<{ source: string }>(ann.gameId, "SELECT source FROM orders WHERE phase = ? AND power = ?", current, bob.power);
    expect(mine[0]!.source).toBe("human");
  });

  it("an empty order list is not a move: it cannot be used to dodge civil disorder", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    for (const phase of ["S1901M", "F1901M"]) {
      a.send({ t: "orders.set", p: { phase, orders: [] } });
      await a.next("orders.ack");
      a.send({ t: "ready", p: { phase, ready: true } });
      await a.next("state", (m) => m.p.phase !== phase);
    }
    expect(await seatOf(ann.gameId, ann.power)).toMatchObject({ kind: "civil_disorder", missed: 2 });
  });

  it("does not hand a seat to anyone while its player is merely away", async () => {
    const { ann, bob } = await bobGoesMissing(2);
    // Two misses is civil disorder, not a vacancy.
    expect((await joinRaw(ann.gameId, { name: "Stranger", power: bob.power })).status).toBe(409);
    expect((await inviteSubstitute(ann, bob.power)).status).toBe(409);
    expect((await joinRaw(ann.gameId, { name: "Stranger", power: bob.power, invite: "0".repeat(32) })).status).toBe(403);
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "civil_disorder", name: "Bob" });
  });

  it("A2, A10: after four misses a seated player may invite a substitute, who takes the seat and locks the old sockets out", async () => {
    const { ann, bob, a, b, bobUnits } = await bobGoesMissing(4);
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "civil_disorder", missed: 4, autopilot: true });
    // Still nobody walks in off the street.
    expect((await joinRaw(ann.gameId, { name: "Stranger", power: bob.power })).status).toBe(409);
    // Only a seated player can issue the invite, and not for their own seat.
    expect((await inviteSubstitute({ ...ann, token: `${ann.gameId}.${ann.power}.${"0".repeat(48)}` }, bob.power)).status).toBe(403);
    expect((await inviteSubstitute(ann, ann.power)).status).toBe(404);
    const issued = await inviteSubstitute(ann, bob.power);
    expect(issued.status).toBe(200);
    const { invite } = (await issued.json()) as { invite: string };
    // A10: Ann cannot use it herself to hold two seats.
    const greedy = await joinRaw(ann.gameId, { name: "Ann again", invite }, ann.token);
    expect(greedy.status).toBe(409);
    expect(((await greedy.json()) as { error: string }).error).toContain("already hold a seat");

    const joined = await joinRaw(ann.gameId, { name: "Sam", invite });
    expect(joined.status).toBe(200);
    const sam = (await joined.json()) as Seat;
    expect(sam.power).toBe(bob.power);
    expect(sam.token).not.toBe(bob.token);
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "human", name: "Sam", missed: 0 });
    // The invite is spent.
    expect((await joinRaw(ann.gameId, { name: "Late", invite })).status).toBe(403);

    // A2: Bob's open socket is closed, and his token no longer binds one.
    expect(await b.untilClosed()).toMatchObject({ code: 4001, reason: "seat reassigned" });
    const stale = await Client.connect(ann.gameId, bob.token);
    expect((await stale.next("error")).p.code).toBe("bad_token");
    const s = await Client.connect(ann.gameId, sam.token);
    expect((await s.next("welcome")).p.power).toBe(bob.power);
    // Ann whispers to the seat Sam now owns. Bob's dead socket sees nothing and can order nothing.
    b.clear();
    a.send({ t: "press.send", p: { to: bob.power, body: "for Sam only" } });
    expect((await s.next("press")).p.body).toBe("for Sam only");
    const phase = (await summary(ann.gameId)).phase;
    try {
      b.send({ t: "orders.set", id: "stale", p: { phase, orders: bobUnits.map((u) => `${u} H`) } });
    } catch {
      // the socket is closed: sending may throw, which is the point
    }
    await sleep(100);
    expect(b.frames.some((m) => m.t === "press")).toBe(false);
    expect(b.frames.some((m) => m.t === "orders.ack")).toBe(false);
    expect((await sql<{ source: string }>(ann.gameId, "SELECT source FROM orders WHERE phase = ? AND power = ?", phase, bob.power))[0]?.source).not.toBe("human");
  }, 60_000);

  it("A8: a substitute can join while a live game is paused", async () => {
    const { ann, bob, a } = await bobGoesMissing(4, { pacing: "live" });
    const { invite } = (await (await inviteSubstitute(ann, bob.power)).json()) as { invite: string };
    a.close();
    await untilStatus(ann.gameId, "paused");
    const joined = await joinRaw(ann.gameId, { name: "Sam", invite });
    expect(joined.status).toBe(200);
    // Sam arriving is a human arriving: the game resumes.
    const sam = (await joined.json()) as Seat;
    const s = await Client.connect(ann.gameId, sam.token);
    expect((await s.next("welcome")).p.status).toBe("active");
  }, 60_000);

  it("an invite dies when the missing player returns first", async () => {
    const { ann, bob, b, bobUnits } = await bobGoesMissing(4);
    const { invite } = (await (await inviteSubstitute(ann, bob.power)).json()) as { invite: string };
    const phase = (await summary(ann.gameId)).phase;
    b.send({ t: "orders.set", p: { phase, orders: bobUnits.map((u) => `${u} H`) } });
    await b.next("orders.ack", (m) => m.p.phase === phase);
    expect((await joinRaw(ann.gameId, { name: "Sam", invite })).status).toBe(403);
    expect(await seatOf(ann.gameId, bob.power)).toMatchObject({ kind: "human", name: "Bob" });
  }, 60_000);

  it("two joins at once never land on the same seat", async () => {
    const ann = await create("Ann", { aiFill: true });
    const target = POWERS.find((p) => p !== ann.power)!;
    const [r1, r2] = await Promise.all([joinRaw(ann.gameId, { name: "X", power: target }), joinRaw(ann.gameId, { name: "Y", power: target })]);
    const [j1, j2] = [(await r1.json()) as Seat, (await r2.json()) as Seat];
    expect(j1.power).not.toBe(j2.power);
    for (const seat of [j1, j2]) {
      const c = await Client.connect(ann.gameId, seat.token);
      expect((await c.next("welcome")).p.power).toBe(seat.power);
    }
  });
});

describe("draws", () => {
  async function three(settings: Record<string, unknown>) {
    const ann = await create("Ann", { aiFill: true, ...settings });
    const bob = await join(ann.gameId, "Bob");
    const cal = await join(ann.gameId, "Cal");
    await start(ann);
    const seats = [ann, bob, cal];
    const clients = await Promise.all(seats.map((seat) => Client.connect(ann.gameId, seat.token)));
    const welcomes = await Promise.all(clients.map((client) => client.next("welcome")));
    return { ann, bob, cal, seats, clients, welcomes };
  }

  it("A3: two yes votes out of seven do not end a non-DIAS game", async () => {
    const seats = [await create("P1", { aiFill: false, dias: false })];
    for (let i = 2; i <= 7; i++) seats.push(await join(seats[0]!.gameId, `P${i}`));
    const clients = await Promise.all(seats.map((s) => Client.connect(s.gameId, s.token)));
    for (const c of clients) await c.next("welcome");
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: true } });
    const votes = await clients[6]!.next("votes", (m) => m.p.draw.length === 2);
    expect(votes.p.required).toHaveLength(7);
    await sleep(100);
    expect((await summary(seats[0]!.gameId)).status).toBe("active");
  });

  it("DIAS needs every surviving player and shares the draw among all survivors", async () => {
    const { ann, clients } = await three({ dias: true });
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: true, include: [ann.power] } });
    await clients[2]!.next("votes", (m) => m.p.draw.length === 2);
    expect((await summary(ann.gameId)).status).toBe("active");
    // A no is a veto.
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: false } });
    await clients[0]!.next("votes", (m) => m.p.draw.length === 3);
    expect((await summary(ann.gameId)).status).toBe("active");
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: true } });
    const finished = await clients[0]!.next("finished");
    // The subset one voter named is ignored under DIAS: all seven survivors share.
    expect(finished.p).toMatchObject({ result: "draw", reason: "vote" });
    expect(finished.p.winners).toHaveLength(7);
  });

  it("non-DIAS still needs everyone, and changes only who shares", async () => {
    const { ann, bob, cal, clients } = await three({ dias: false });
    const pair = [ann.power, bob.power].sort();
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true, include: pair } });
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: true, include: pair } });
    // Cal agrees to a draw, but to a different one: no draw.
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: true } });
    const split = await clients[0]!.next("votes", (m) => m.p.draw.length === 3);
    expect(split.p.draw.find((v) => v.power === cal.power)).toMatchObject({ value: true, include: null });
    expect(split.p.draw.find((v) => v.power === ann.power)).toMatchObject({ value: true, include: pair });
    await sleep(60);
    expect((await summary(ann.gameId)).status).toBe("active");
    // A draw cannot name a power that is not on the board.
    await sql(ann.gameId, "UPDATE seats SET eliminated = 1 WHERE kind = 'ai' AND power = (SELECT MIN(power) FROM seats WHERE kind = 'ai')");
    const gone = (await summary(ann.gameId)).seats.find((s) => s.eliminated)!.power;
    clients[2]!.send({ t: "vote", id: "bad", p: { kind: "draw", value: true, include: [gone] } });
    expect((await clients[2]!.next("error")).p.code).toBe("bad_vote");
    // Cal concedes the two-way draw.
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: true, include: pair } });
    const finished = await clients[0]!.next("finished");
    expect(finished.p.result).toBe("draw");
    expect(finished.p.winners).toEqual(pair);
    expect(finished.p.scores[cal.power]).toBe(0);
    expect(finished.p.scores[ann.power]! + finished.p.scores[bob.power]!).toBeCloseTo(1);
  });

  it("clears votes when the phase resolves: a yes from last phase counts for nothing", async () => {
    const { ann, clients, welcomes, seats } = await three({ dias: true });
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
    await clients[1]!.next("votes", (m) => m.p.draw.length === 1);
    for (let i = 0; i < 3; i++) {
      const units = welcomes[i]!.p.state.units[seats[i]!.power]!;
      clients[i]!.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
      clients[i]!.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    }
    await clients[0]!.next("state", (m) => m.p.phase === "F1901M");
    // Everyone is told the slate is clean.
    expect((await clients[1]!.next("votes", (m) => m.p.phase === "F1901M")).p.draw).toEqual([]);
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: true } });
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: true } });
    await clients[0]!.next("votes", (m) => m.p.draw.length === 2);
    await sleep(60);
    expect((await summary(ann.gameId)).status).toBe("active");
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await clients[0]!.next("finished")).p.result).toBe("draw");
  });

  it("ghosts never veto: an eliminated player, a seat in civil disorder and AI seats are not required", async () => {
    const { ann, bob, cal, clients } = await three({ dias: true });
    await sql(ann.gameId, "UPDATE seats SET eliminated = 1 WHERE power = ?", bob.power);
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2 WHERE power = ?", cal.power);
    // The eliminated player may still cast a visible vote, and it changes nothing.
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: false } });
    const votes = await clients[0]!.next("votes");
    expect(votes.p.required).toEqual([ann.power]);
    expect(votes.p.draw).toEqual([{ power: bob.power, value: false, include: null }]);
    // A seat in civil disorder cannot vote at all until its player is back.
    clients[2]!.send({ t: "vote", p: { kind: "draw", value: false } });
    expect((await clients[2]!.next("error")).p.code).toBe("seat_inactive");
    clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await clients[0]!.next("finished")).p.result).toBe("draw");
  });

  it("with ghost votes off, an eliminated player cannot vote", async () => {
    const { ann, bob, clients } = await three({ ghostVotes: false });
    await sql(ann.gameId, "UPDATE seats SET eliminated = 1 WHERE power = ?", bob.power);
    clients[1]!.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await clients[1]!.next("error")).p.code).toBe("seat_inactive");
    expect(await sql(ann.gameId, "SELECT * FROM votes")).toHaveLength(0);
  });

  it("a game with no present human cannot be drawn by vote", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    await sql(ann.gameId, "UPDATE seats SET eliminated = 1 WHERE power = ?", ann.power);
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await a.next("votes")).p.required).toEqual([]);
    await sleep(60);
    expect((await summary(ann.gameId)).status).toBe("active");
  });
});

describe("adjudication", () => {
  it("C1: is one transaction. A failure after the engine has run leaves no trace, and the retry applies the phase once", async () => {
    const ann = await create("Ann", { aiFill: true, graceSeconds: 0 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    a.send({ t: "press.send", p: { to: "ALL", body: "I hold.", pledge: { orders: [`${units[0]} H`], sealed: false } } });
    await a.next("press");
    const before = await summary(ann.gameId);
    a.clear();
    // Let the whole phase be applied (counters, phase row, receipts, next deadline), then throw.
    await inRoom(ann.gameId, (room) => {
      const real = room.applyOutcome.bind(room);
      let thrown = false;
      room.applyOutcome = (...args: unknown[]) => {
        real(...args);
        if (!thrown) {
          thrown = true;
          throw new Error("storage hiccup after the phase was applied");
        }
      };
      room.meta.deadlineAt = Date.now() - 1;
    });
    await fireAlarm(ann.gameId);
    // Nothing happened: not in storage, not in memory, not on the wire.
    expect(await phaseCount(ann.gameId)).toBe(0);
    const failed = await summary(ann.gameId);
    expect(failed.phase).toBe("S1901M");
    expect(failed.status).toBe("active");
    expect(failed.seats).toEqual(before.seats);
    expect((await sql<{ receipt: string | null }>(ann.gameId, "SELECT receipt FROM pledges"))[0]!.receipt).toBeNull();
    expect(a.has("results")).toBe(false);
    expect(a.has("state")).toBe(false);
    expect(a.has("pledge.receipt")).toBe(false);
    expect((await a.next("error")).p.code).toBe("adjudication_retry");
    const retry = await inRoom(ann.gameId, (room) => room.meta.retry);
    expect(retry).toMatchObject({ attempts: 1 });
    expect(retry!.at - Date.now()).toBeLessThanOrEqual(5_000);
    expect(retry!.at - Date.now()).toBeGreaterThan(0);

    // The alarm fires again (twice, as a duplicate delivery would).
    await inRoom(ann.gameId, (room) => {
      room.meta.retry!.at = Date.now() - 1;
    });
    await fireAlarm(ann.gameId);
    await fireAlarm(ann.gameId);
    expect(await phaseCount(ann.gameId)).toBe(1);
    expect((await summary(ann.gameId)).phase).toBe("F1901M");
    expect(await seatOf(ann.gameId, ann.power)).toMatchObject({ missed: 1 });
    // Applied exactly once: one receipt (void, since Ann ordered nothing), one miss, one phase row.
    expect(await sql<{ receipt: string | null }>(ann.gameId, "SELECT receipt FROM pledges")).toEqual([{ receipt: "void" }]);
    expect((await a.next("results")).p.phase).toBe("S1901M");
  });

  it("survives eviction: the room comes back on the same phase with the same deadline and its alarm armed", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    await holdAndReady(a, units, "S1901M");
    const before = await summary(ann.gameId);
    const orders = await sql(ann.gameId, "SELECT phase, power, orders_json, source FROM orders ORDER BY phase, power");
    await inRoom(ann.gameId, (_room, state) => state.abort("evicted by the test")).catch(() => undefined);
    const after = await until(async () => summary(ann.gameId).catch(() => null), "the room to come back");
    expect(after).toEqual(before);
    expect(await phaseCount(ann.gameId)).toBe(1);
    expect(await sql(ann.gameId, "SELECT phase, power, orders_json, source FROM orders ORDER BY phase, power")).toEqual(orders);
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBe(before.deadlineAt);
    const replay = (await (await stubOf(ann.gameId).fetch("https://room/replay")).json()) as { phases: { name: string }[] };
    expect(replay.phases.map((p) => p.name)).toEqual(["S1901M", "F1901M"]);
  });

  it("A7: a failing adjudication does not freeze the room; orders can still be corrected", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    await inRoom(ann.gameId, (room) => {
      room.resolvePhase = () => {
        throw new Error("engine bug");
      };
      room.adjudicate();
      room.settle();
    });
    const s = await summary(ann.gameId);
    expect(s).toMatchObject({ status: "active", phase: "S1901M", pauseReason: null });
    a.send({ t: "orders.set", id: "fix", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    expect((await a.next("orders.ack")).p.accepted).toHaveLength(units.length);
    // Readying does not hammer a failing engine: the retry runs on its own clock.
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await sleep(80);
    expect(await inRoom(ann.gameId, (room) => room.meta.retry?.attempts)).toBe(1);
  });

  it("B6: retries a failing adjudication on a bounded backoff, then resolves the phase with every unit holding", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const opening = (await a.next("welcome")).p.state;
    a.send({ t: "press.send", p: { to: "ALL", body: "I hold.", pledge: { orders: [`${opening.units[ann.power]![0]} H`], sealed: false } } });
    await a.next("press");
    let calls = 0;
    await inRoom(ann.gameId, (room) => {
      room.resolvePhase = () => {
        calls++;
        throw new Error("engine bug");
      };
      room.adjudicate();
      room.settle();
    });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retry = await inRoom(ann.gameId, (room) => room.meta.retry);
      expect(retry!.attempts).toBe(attempt);
      delays.push(retry!.at - Date.now());
      expect((await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm()))).toBe(retry!.at);
      await inRoom(ann.gameId, (room) => {
        room.meta.retry!.at = Date.now() - 1;
      });
      await fireAlarm(ann.gameId);
    }
    // 5 s, 15 s, 45 s, and then no fifth attempt: the phase resolves with holds.
    for (const [i, want] of [5_000, 15_000, 45_000].entries()) {
      expect(delays[i]).toBeLessThanOrEqual(want);
      expect(delays[i]).toBeGreaterThan(want - 4_000);
    }
    expect(calls).toBe(4);
    const s = await summary(ann.gameId);
    expect(s).toMatchObject({ status: "active", phase: "F1901M" });
    expect(await inRoom(ann.gameId, (room) => room.meta.retry)).toBeNull();
    // Every unit is where it started.
    const state = (await a.next("state", (m) => m.p.phase === "F1901M")).p.state;
    for (const power of POWERS) expect([...state.units[power]!].sort()).toEqual([...opening.units[power]!].sort());
    expect((await a.next("error", (m) => m.p.code === "adjudication_fallback")).p.message).toContain("held");
    expect(await phaseCount(ann.gameId)).toBe(1);
    // Nothing anyone ordered was adjudicated, so the pledge is void, not kept or broken.
    expect((await a.next("pledge.receipt")).p.receipt).toBe("void");
  });

  it("ends the game instead of freezing if even an all-hold phase cannot be resolved", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    await inRoom(ann.gameId, (room) => {
      const game = (room as unknown as { game: { process: () => never } }).game;
      game.process = () => {
        throw new Error("engine is broken");
      };
      room.adjudicate(true);
      room.settle();
    });
    expect(await summary(ann.gameId)).toMatchObject({ status: "abandoned", finished: { result: "abandoned", reason: "adjudication_failed" } });
  });
});

describe("deadlines", () => {
  it("grants the grace period once, only when a player still owes orders", async () => {
    const ann = await create("Ann", { aiFill: true, graceSeconds: 120 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    a.clear();
    // Ann has sent nothing. The deadline arrives: she gets the grace period, and the phase waits.
    await deadlineIn(ann.gameId, 40);
    const grace = await a.next("deadline", (m) => m.p.grace === true);
    expect(grace.p.deadlineAt! - Date.now()).toBeGreaterThan(110_000);
    expect(grace.p.deadlineAt! - Date.now()).toBeLessThanOrEqual(120_000);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    expect(await phaseCount(ann.gameId)).toBe(0);
    // Grace is granted once. The next time the clock runs out the phase resolves, orders or not.
    await deadlineIn(ann.gameId, 40);
    await a.next("state", (m) => m.p.phase === "F1901M");
    // A player who has moved gets no grace: the deadline is the deadline.
    a.send({ t: "orders.set", p: { phase: "F1901M", orders: units.map((u) => `${u} H`) } });
    await a.next("orders.ack");
    a.clear();
    await deadlineIn(ann.gameId, 40);
    await untilPhase(ann.gameId, (phase) => phase !== "F1901M");
    expect(a.frames.some((m) => m.t === "deadline" && m.p.grace === true)).toBe(false);
  });

  it("lets a lone player extend alone, and only a present player ask", async () => {
    const ann = await create("Ann", { aiFill: true, pacing: "daily" });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const before = (await summary(ann.gameId)).deadlineAt!;
    a.send({ t: "extend", p: { phase: "S1901M" } });
    expect((await a.next("extend.ack")).p).toMatchObject({ requests: 1, extended: true });
    expect((await a.next("extend")).p).toMatchObject({ needed: 1, granted: true });
    expect((await summary(ann.gameId)).deadlineAt).toBe(before + 43_200_000);
    // The alarm moved with the deadline.
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBe(before + 43_200_000);
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder' WHERE power = ?", ann.power);
    await sql(ann.gameId, "DELETE FROM phase_extensions");
    a.send({ t: "extend", p: { phase: "S1901M" } });
    expect((await a.next("error")).p.code).toBe("seat_inactive");
  });

  it("makes rulebook press an option: press stays open in retreats unless the game asks otherwise", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const state = new Game().state();
    const enemy = POWERS.find((power) => power !== ann.power)!;
    state.units = { [ann.power]: ["A BUR"], [enemy]: ["A MUN", "A RUH"] };
    const staged = Game.fromState(state);
    staged.process({ orders: { [enemy]: ["A MUN - BUR", "A RUH S A MUN - BUR"] } });
    await inRoom(ann.gameId, async (room, storage) => {
      (room as unknown as { game: Game }).game = staged;
      await storage.storage.put("saved", staged.toSaved(ann.gameId));
    });
    const a = await Client.connect(ann.gameId, ann.token);
    expect((await a.next("welcome")).p.phase).toBe("S1901R");
    a.send({ t: "press.send", p: { to: "ALL", body: "open during retreats" } });
    expect((await a.next("press")).p.body).toBe("open during retreats");
  });

  it("leaves the whisper budget unlimited unless the game sets one", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const target = POWERS.find((p) => p !== ann.power)!;
    for (let i = 0; i < 12; i++) a.send({ t: "press.send", p: { to: target, body: `w${i}` } });
    await until(async () => (await sql(ann.gameId, "SELECT id FROM press")).length === 12, "twelve whispers");
    expect(a.has("error")).toBe(false);
  });

  it("A6: pipelined whispers cannot exceed the budget", async () => {
    const ann = await create("Ann", { aiFill: true, whisperBudget: 2 });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const target = POWERS.find((p) => p !== ann.power)!;
    for (let i = 0; i < 8; i++) a.send({ t: "press.send", p: { to: target, body: `w${i}` } });
    await a.next("error", (m) => m.p.code === "whisper_budget");
    await sleep(200);
    expect(await sql(ann.gameId, "SELECT id FROM press WHERE recipient <> 'ALL'")).toHaveLength(2);
  });
});
