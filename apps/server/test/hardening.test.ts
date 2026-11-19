/**
 * Regression tests for what the adversarial reviews of the room found: a retreat the validator
 * refused, sockets that could lock players out, storage that grew without bound inside one phase,
 * unlisted games that were published when they ended, draws that cut out players with no vote,
 * submissions that wiped the orders standing in for a player, and an alarm that could spin.
 * Every test drives the real Worker over HTTP and sockets.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/room.js";
import {
  Client,
  POWERS,
  type Seat,
  create,
  deadlineIn,
  inRoom,
  join,
  nextIp,
  sleep,
  sql,
  start,
  summary,
  until,
  untilIndexed,
  untilStatus,
} from "./helpers.js";

const phaseCount = async (gameId: string) => (await sql<{ n: number }>(gameId, "SELECT COUNT(*) AS n FROM phases"))[0]!.n;

/** Let the current phase run out its clock and wait until it has resolved. */
async function resolve(gameId: string): Promise<void> {
  const before = await phaseCount(gameId);
  await deadlineIn(gameId, 15);
  await until(async () => (await phaseCount(gameId)) > before, "the phase to resolve");
}

/** Seven human seats, one per power, so a test decides every order on the board. */
async function fullTable(settings: Record<string, unknown> = {}): Promise<{ gameId: string; seats: Record<string, Seat> }> {
  const host = await create("Host", { aiFill: false, graceSeconds: 0, readyAdvance: false, ...settings });
  const seats: Record<string, Seat> = { [host.power]: host };
  for (const power of POWERS) seats[power] ??= await join(host.gameId, power, power);
  expect((await summary(host.gameId)).status).toBe("active");
  return { gameId: host.gameId, seats };
}

async function order(client: Client, phase: string, orders: string[]) {
  const id = `o${Math.random()}`;
  client.send({ t: "orders.set", id, p: { phase, orders } });
  return (await client.next("orders.ack", (m) => m.id === id)).p;
}

describe("retreats", () => {
  it("BL1: an army dislodged by a fleet can be retreated, disbanded and pledged in the notation its player sees", async () => {
    // Austria takes Venice in Fall 1901 with a fleet, supported from Tyrolia. Nobody else moves.
    const { gameId, seats } = await fullTable({ rulebookPress: false });
    const austria = await Client.connect(gameId, seats.AUSTRIA!.token);
    const italy = await Client.connect(gameId, seats.ITALY!.token);
    await austria.next("welcome");
    await italy.next("welcome");
    expect((await order(austria, "S1901M", ["A VIE - TYR", "F TRI H", "A BUD H"])).accepted).toHaveLength(3);
    expect((await order(italy, "S1901M", ["A VEN H", "A ROM H", "F NAP H"])).accepted).toHaveLength(3);
    await resolve(gameId);
    expect((await order(austria, "F1901M", ["F TRI - VEN", "A TYR S F TRI - VEN", "A BUD H"])).accepted).toHaveLength(3);
    expect((await order(italy, "F1901M", ["A VEN H", "A ROM H", "F NAP H"])).accepted).toHaveLength(3);
    await resolve(gameId);

    const state = await italy.next("state", (m) => m.p.phase === "F1901R");
    // The board names the dislodged unit correctly: an army.
    expect(Object.keys(state.p.state.retreats.ITALY ?? {})).toEqual(["A VEN"]);
    expect(state.p.state.retreats.ITALY!["A VEN"]).toContain("TUS");

    // Somewhere it cannot go is still refused, with a reason.
    const far = await order(italy, "F1901R", ["A VEN R MUN"]);
    expect(far.accepted).toEqual([]);
    expect(far.verdicts[0]).toMatchObject({ ok: false, code: "illegal" });
    // A unit that was not dislodged has no retreat.
    expect((await order(italy, "F1901R", ["A ROM R TUS"])).verdicts[0]).toMatchObject({ ok: false, code: "no_such_unit" });

    // A disband is accepted, and so is the retreat that then replaces it.
    expect((await order(italy, "F1901R", ["A VEN D"])).accepted).toEqual(["A VEN D"]);
    const retreat = await order(italy, "F1901R", ["A VEN R TUS"]);
    expect(retreat.verdicts).toEqual([{ text: "A VEN R TUS", order: "A VEN R TUS", ok: true, code: "ok", reason: "" }]);
    expect(retreat.accepted).toEqual(["A VEN R TUS"]);
    // The engine's menu has printed the attacker's letter here; that spelling means the same retreat.
    expect((await order(italy, "F1901R", ["F VEN R TUS"])).accepted).toEqual(["A VEN R TUS"]);

    // The same order can be pledged, and the receipt is judged against what was filed.
    italy.send({ t: "press.send", id: "p1", p: { to: "ALL", body: "I am going to Tuscany.", pledge: { orders: ["A VEN R TUS"], sealed: false } } });
    const press = await italy.next("press", (m) => m.id === "p1");
    expect(press.p.pledge?.orders).toEqual(["A VEN R TUS"]);

    await resolve(gameId);
    expect((await italy.next("pledge.receipt")).p.receipt).toBe("kept");
    const after = await italy.next("state", (m) => m.p.phase === "W1901A");
    expect(after.p.state.units.ITALY).toContain("A TUS");
    expect(after.p.state.units.AUSTRIA).toContain("F VEN");
  });
});

describe("socket admission", () => {
  it("B1: idle anonymous sockets cannot lock a seat holder out: the oldest makes way", { timeout: 90_000 }, async () => {
    const ann = await create("Ann");
    const idle: Client[] = [];
    for (let i = 0; i < LIMITS.spectators; i++) idle.push(await Client.connect(ann.gameId));
    // The room is full of sockets that never said hello. The player still gets in and takes her seat.
    const a = await Client.connect(ann.gameId, ann.token);
    expect((await a.next("welcome")).p.power).toBe(ann.power);
    // The oldest idle socket was told why and closed; the rest are untouched.
    expect(await idle[0]!.untilClosed()).toMatchObject({ code: 4408 });
    expect(idle[0]!.frames.some((m) => m.t === "error" && m.p.code === "spectator_evicted")).toBe(true);
    expect(idle[1]!.closed).toBeNull();
    // A bound socket holds no spectator place: the next arrival evicts nobody.
    const late = await Client.connect(ann.gameId);
    await late.next("welcome");
    await sleep(50);
    expect(idle[1]!.closed).toBeNull();
    const open = await inRoom(ann.gameId, (_room, state) => state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length);
    expect(open).toBeLessThanOrEqual(LIMITS.spectators + 1);
    for (const c of [...idle, a, late]) c.close();
  });
});

describe("storage inside one phase", () => {
  it("B2: a seat flipping its ready flag stores one seats frame, not one per flip, and runs out of flips", async () => {
    const ann = await create("Ann"); // async pacing: this movement phase lasts two days
    const mallory = await join(ann.gameId, "Mallory");
    await start(ann);
    const m = await Client.connect(ann.gameId, mallory.token);
    await m.next("welcome");
    const before = (await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM events"))[0]!.n;
    let refused = 0;
    for (let i = 0; i < LIMITS.changesPerPhase + 20; i++) {
      m.send({ t: "ready", id: `r${i}`, p: { phase: "S1901M", ready: i % 2 === 0 } });
      if (i % 10 === 9) await sleep(1100); // stay inside the socket's own rate limit
    }
    await until(async () => {
      refused = m.frames.filter((f) => f.t === "error" && f.p.code === "too_many_changes").length;
      // Past the allowance the flag stays where it was, so every other frame asks for a change and is refused.
      return refused === 10;
    }, "the flips over the allowance to be refused");
    expect(m.frames.some((f) => f.t === "error" && f.p.code === "rate_limited")).toBe(false);
    const rows = await sql<{ n: number; seats: number }>(ann.gameId, "SELECT COUNT(*) AS n, SUM(snapshot = 'seats') AS seats FROM events");
    expect(rows[0]!.seats).toBe(1);
    expect(rows[0]!.n - before).toBeLessThanOrEqual(1);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    // A reconnecting client that replays from the start still ends with the seats as they are.
    const seats = (await summary(ann.gameId)).seats;
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    spectator.send({ t: "sync", p: { since: 0 } });
    await spectator.next("synced");
    const replayed = spectator.frames.filter((f) => f.t === "seats").at(-1);
    expect(replayed?.t === "seats" && replayed.p.seats.find((s) => s.power === mallory.power)?.ready).toBe(seats.find((s) => s.power === mallory.power)!.ready);
    m.close();
    spectator.close();
  });

  it("B2: ballots and extension requests are stored once however often they are repeated", async () => {
    const ann = await create("Ann", { publicVotes: false });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    for (let i = 0; i < 12; i++) a.send({ t: "vote", p: { kind: "draw", value: i % 2 === 0 } });
    for (let i = 0; i < 5; i++) a.send({ t: "extend", id: `e${i}`, p: { phase: "S1901M" } });
    await a.next("extend.ack", (m) => m.id === "e4");
    const rows = await sql<{ snapshot: string | null; audience: string; n: number }>(
      ann.gameId,
      "SELECT snapshot, audience, COUNT(*) AS n FROM events WHERE snapshot = 'votes' OR payload_json LIKE '{\"t\":\"extend\"%' GROUP BY snapshot, audience",
    );
    // One votes frame for the table, one for the voter, one extension request: three rows, not thirty.
    expect(rows.map((r) => r.n)).toEqual([1, 1, 1]);
    // A repeated, unchanged ballot costs nothing at all.
    const spent = async () => (await sql<{ n: number }>(ann.gameId, "SELECT n FROM seat_changes WHERE power = ?", ann.power))[0]!.n;
    const n = await spent();
    a.send({ t: "vote", p: { kind: "draw", value: false } });
    a.send({ t: "sync", id: "s", p: { since: 0 } });
    await a.next("synced", (m) => m.id === "s");
    expect(await spent()).toBe(n);
    void bob;
    a.close();
  });

  it("B2: the event store is pruned as it is written, and a cursor that fell out of it is told so", async () => {
    const ann = await create("Ann");
    await start(ann);
    await inRoom(ann.gameId, (room) => {
      const r = room as unknown as { broadcast(message: unknown, audience: string): number; pending: unknown[] };
      for (let i = 0; i < LIMITS.eventsKept + 150; i++) r.broadcast({ t: "error", p: { code: "noise", message: "x".repeat(200) } }, "ALL");
      r.pending.length = 0;
    });
    const rows = await sql<{ n: number; oldest: number; newest: number }>(ann.gameId, "SELECT COUNT(*) AS n, MIN(seq) AS oldest, MAX(seq) AS newest FROM events");
    expect(rows[0]!.n).toBeLessThanOrEqual(LIMITS.eventsKept);
    expect(rows[0]!.oldest).toBe(rows[0]!.newest - LIMITS.eventsKept + 1);
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    spectator.send({ t: "sync", id: "old", p: { since: 1 } });
    expect((await spectator.next("synced", (m) => m.id === "old")).p).toMatchObject({ gap: true });
    spectator.send({ t: "sync", id: "new", p: { since: rows[0]!.newest - 3 } });
    expect((await spectator.next("synced", (m) => m.id === "new")).p).toMatchObject({ gap: false, seq: rows[0]!.newest });
    spectator.close();
  });
});

describe("the public list of finished games", () => {
  const listFinished = async () =>
    ((await (await SELF.fetch("http://cabal/api/games?limit=100", { headers: { "cf-connecting-ip": nextIp() } })).json()) as { games: { gameId: string }[] }).games;

  async function playToDraw(settings: Record<string, unknown>): Promise<Seat> {
    const ann = await create("Ann Private", { graceSeconds: 0, ...settings });
    await start(ann);
    await resolve(ann.gameId);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    await untilStatus(ann.gameId, "finished");
    await untilIndexed(ann.gameId);
    a.close();
    return ann;
  }

  it("B3: an unlisted game is recorded when it ends but never published", async () => {
    const hidden = await playToDraw({});
    expect((await summary(hidden.gameId)).settings.visibility).toBe("unlisted");
    const shown = await playToDraw({ visibility: "public" });
    const listed = (await listFinished()).map((g) => g.gameId);
    expect(listed).toContain(shown.gameId);
    expect(listed).not.toContain(hidden.gameId);
    // The record itself exists: ratings and the ledger are built from every game.
    expect((await untilIndexed(hidden.gameId)).result).toBe("draw");
  });

  it("B3: a public game that ended before a phase was played is not worth a line", async () => {
    const ann = await create("Ann", { visibility: "public" });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    await untilStatus(ann.gameId, "finished");
    await untilIndexed(ann.gameId);
    expect((await listFinished()).map((g) => g.gameId)).not.toContain(ann.gameId);
    a.close();
  });
});

describe("draws without DIAS", () => {
  it("O1: a lone human cannot vote the AI powers out of a draw", async () => {
    const ann = await create("Ann", { aiFill: true, dias: false });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    a.send({ t: "vote", id: "v", p: { kind: "draw", value: true, include: [ann.power] } });
    const error = await a.next("error", (m) => m.id === "v");
    expect(error.p.code).toBe("bad_vote");
    expect((await summary(ann.gameId)).status).toBe("active");
    a.close();
  });

  it("O1: a player who lapses into civil disorder is not cut out by a proposal he never agreed to", async () => {
    const ann = await create("Ann", { aiFill: true, dias: false });
    const bob = await join(ann.gameId, "Bob");
    const cal = await join(ann.gameId, "Cal");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    const withoutCal = POWERS.filter((p) => p !== cal.power);
    // While Cal has a vote he may be proposed out, and the draw waits for him.
    a.send({ t: "vote", p: { kind: "draw", value: true, include: withoutCal } });
    b.send({ t: "vote", id: "b1", p: { kind: "draw", value: true, include: withoutCal } });
    await b.next("votes");
    await sleep(100);
    expect((await summary(ann.gameId)).status).toBe("active");
    // Cal goes quiet for two movement phases and loses his vote. He does not lose his share: the
    // proposal that waited for him cannot now be completed without him.
    await sql(ann.gameId, "UPDATE seats SET kind = 'civil_disorder', missed = 2 WHERE power = ?", cal.power);
    b.send({ t: "vote", p: { kind: "draw", value: false } });
    b.send({ t: "vote", id: "b2", p: { kind: "draw", value: true, include: withoutCal } });
    expect((await b.next("error", (m) => m.id === "b2")).p).toMatchObject({ code: "bad_vote" });
    expect((await summary(ann.gameId)).status).toBe("active");
    // The two who are playing can still end the game, with Cal in it.
    a.send({ t: "vote", p: { kind: "draw", value: true, include: [...POWERS] } });
    b.send({ t: "vote", p: { kind: "draw", value: true, include: [...POWERS] } });
    const done = await untilStatus(ann.gameId, "finished");
    expect(done.finished!.winners).toContain(cal.power);
    expect(done.finished!.scores[cal.power]).toBeGreaterThan(0);
    a.close();
    b.close();
  });
});

describe("orders that order nothing", () => {
  it("O3: clearing a draft falls back to the sealed defaults, as sending nothing does", async () => {
    const { gameId, seats } = await fullTable();
    const turkey = await Client.connect(gameId, seats.TURKEY!.token);
    await turkey.next("welcome");
    turkey.send({ t: "orders.default", id: "d", p: { orders: ["A CON - BUL"] } });
    await turkey.next("orders.default.ack", (m) => m.id === "d");
    expect((await order(turkey, "S1901M", ["A CON H"])).accepted).toEqual(["A CON H"]);
    expect((await summary(gameId)).seats.find((s) => s.power === "TURKEY")!.submitted).toBe(true);
    // The client clears its draft.
    expect((await order(turkey, "S1901M", [])).accepted).toEqual([]);
    expect((await summary(gameId)).seats.find((s) => s.power === "TURKEY")!.submitted).toBe(false);
    await resolve(gameId);
    const state = await turkey.next("state", (m) => m.p.phase === "F1901M");
    expect(state.p.state.units.TURKEY).toContain("A BUL");
    turkey.close();
  });

  it("O3: garbage from a seat in civil disorder does not wipe the bot's cover", async () => {
    const ann = await create("Ann", { aiFill: true, graceSeconds: 0 });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    // Bob says nothing for two movement phases and is in civil disorder; the bot covers him.
    for (const phase of ["S1901M", "F1901M"]) {
      await order(a, phase, units.map((u) => `${u} H`));
      await resolve(gameId(ann));
      if ((await summary(ann.gameId)).phase.endsWith("R")) await resolve(ann.gameId);
    }
    await until(async () => (await summary(ann.gameId)).phase.endsWith("M") || (await summary(ann.gameId)).phase.endsWith("A"), "the next phase");
    while (!(await summary(ann.gameId)).phase.endsWith("M")) await resolve(ann.gameId);
    const s = await summary(ann.gameId);
    expect(s.seats.find((x) => x.power === bob.power)).toMatchObject({ kind: "civil_disorder", autopilot: true });
    const cover = async () => (await sql<{ orders_json: string; source: string }>(ann.gameId, "SELECT orders_json, source FROM orders WHERE phase = ? AND power = ?", s.phase, bob.power))[0];
    const before = await cover();
    expect(before?.source).toBe("bot");
    expect(JSON.parse(before!.orders_json).length).toBeGreaterThan(0);
    const b = await Client.connect(ann.gameId, bob.token);
    await b.next("welcome");
    const ack = await order(b, s.phase, ["this is not an order"]);
    expect(ack.accepted).toEqual([]);
    expect(ack.verdicts[0]).toMatchObject({ ok: false, code: "syntax" });
    expect(await cover()).toEqual(before);
    expect((await summary(ann.gameId)).seats.find((x) => x.power === bob.power)!.kind).toBe("civil_disorder");
    a.close();
    b.close();
  });
});

const gameId = (seat: Seat) => seat.gameId;

describe("replies a client can match", () => {
  it("O4: a rate-limited or invalid frame is answered with the id it carried", async () => {
    const ann = await create("Ann");
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    spectator.send({ t: "no-such-frame", id: "x1", p: {} });
    expect((await spectator.next("error", (m) => m.p.code === "bad_frame")).id).toBe("x1");
    for (let i = 0; i < 60; i++) spectator.send({ t: "sync", id: `s${i}`, p: { since: 0 } });
    const limited = await spectator.next("error", (m) => m.p.code === "rate_limited");
    expect(limited.id).toMatch(/^s\d+$/);
    spectator.close();
  });

  it("O6: a full-length message in a three-byte script fits in a frame", async () => {
    const ann = await create("Ann");
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const body = "战".repeat(4000);
    a.send({ t: "press.send", id: "long", p: { to: "ALL", body } });
    expect((await a.next("press", (m) => m.id === "long")).p.body).toBe(body);
    expect(a.closed).toBeNull();
    a.close();
  });
});

describe("the alarm", () => {
  it("O1: an alarm that keeps failing backs off instead of spinning", async () => {
    const ann = await create("Ann");
    await start(ann);
    let calls = 0;
    await inRoom(ann.gameId, (room) => {
      (room as unknown as { onDeadline: () => void }).onDeadline = () => {
        calls++;
        throw new Error("injected: deadline handling is broken");
      };
    });
    await deadlineIn(ann.gameId, 10);
    await sleep(1200);
    const armed = await inRoom(ann.gameId, async (room, state) => ({ at: await state.storage.getAlarm(), want: (room as unknown as { alarmAt(): number | null }).alarmAt() }));
    // It ran once, and the next attempt is seconds away, not now.
    expect(calls).toBe(1);
    expect(armed.at).toBe(armed.want);
    expect(armed.at! - Date.now()).toBeGreaterThan(500);
    await inRoom(ann.gameId, (room) => {
      room.meta.deadlineAt = Date.now() + 3600_000;
      room.kv.put("meta", room.meta);
      room.rearm();
    });
  });
});

describe("health", () => {
  it("O3: /health is rate limited like every other read", { timeout: 60_000 }, async () => {
    let limited = 0;
    for (let i = 0; i < 330; i++) {
      const res = await SELF.fetch("http://cabal/health", { headers: { "cf-connecting-ip": "203.0.113.9" } });
      if (res.status === 429) limited++;
      await res.arrayBuffer();
    }
    expect(limited).toBeGreaterThan(0);
  });
});
