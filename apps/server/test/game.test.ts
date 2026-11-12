import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Game } from "@cabal/engine";
import type { ServerMessage } from "@cabal/protocol";
import type { Env as ServerEnv } from "../src/env.js";

const serverEnv = env as unknown as ServerEnv;
let requestSequence = 0;
const nextIp = () => `198.51.100.${(++requestSequence % 250) + 1}`;

beforeAll(async () => {
  await serverEnv.DB?.prepare(`CREATE TABLE IF NOT EXISTS games_index (
    game_id TEXT PRIMARY KEY, result TEXT NOT NULL, winners_json TEXT NOT NULL, scores_json TEXT NOT NULL,
    settings_json TEXT NOT NULL, phase_count INTEGER NOT NULL, finished_at INTEGER NOT NULL, ledger_json TEXT NOT NULL
  )`).run();
});

async function create(name: string, settings: Record<string, unknown> = {}) {
  const res = await SELF.fetch("http://cabal/api/games", {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp() },
    body: JSON.stringify({ name, settings }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { gameId: string; token: string; power: string };
}

async function join(gameId: string, name: string) {
  const res = await SELF.fetch(`http://cabal/api/games/${gameId}/join`, {
    method: "POST",
    headers: { "cf-connecting-ip": nextIp() },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { gameId: string; token: string; power: string };
}

async function seedGame(gameId: string, game: Game): Promise<void> {
  const stub = serverEnv.GAME_ROOM.get(serverEnv.GAME_ROOM.idFromName(gameId));
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as { game: Game }).game = game;
    await state.storage.put("saved", game.toSaved(gameId));
  });
}

class Client {
  ws: WebSocket;
  frames: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data as string) as ServerMessage;
      this.frames.push(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w!.resolve(m);
      }
    });
  }

  static async connect(gameId: string, token?: string): Promise<Client> {
    const res = await SELF.fetch(`http://cabal/api/games/${gameId}/ws${token ? `?token=${token}` : ""}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    return new Client(res.webSocket!);
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws.close();
  }

  next<T extends ServerMessage["t"]>(t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const existing = this.frames.find((m) => m.t === t);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer);
          this.frames.splice(this.frames.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }
}

describe("GameRoom", () => {
  it("creates a game with a lobby and seven seats", async () => {
    const ann = await create("Ann");
    expect(ann.gameId).toMatch(/^[A-Z0-9]{6}$/);
    const res = await SELF.fetch(`http://cabal/api/games/${ann.gameId}`);
    const summary = (await res.json()) as { status: string; seats: { kind: string }[]; phase: string };
    expect(summary.status).toBe("lobby");
    expect(summary.seats).toHaveLength(7);
    expect(summary.seats.filter((s) => s.kind === "human")).toHaveLength(1);
    expect(summary.phase).toBe("S1901M");
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

    const start = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    expect(start.status).toBe(200);
    const summary = (await start.json()) as { status: string; seats: { kind: string }[] };
    expect(summary.status).toBe("active");
    expect(summary.seats.filter((s) => s.kind === "ai")).toHaveLength(5);

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
    expect((await ledger.json() as { ledger: Record<string, { kept: number }> }).ledger[ann.power]!.kept).toBe(1);
  });

  it("fires a deadline alarm and applies stored default movement orders", async () => {
    const moves: Record<string, string> = {
      AUSTRIA: "A VIE - GAL",
      ENGLAND: "F LON - NTH",
      FRANCE: "A PAR - BUR",
      GERMANY: "A MUN - RUH",
      ITALY: "A VEN - PIE",
      RUSSIA: "A MOS - UKR",
      TURKEY: "A CON - BUL",
    };
    const ann = await create("Ann", { aiFill: true });
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const client = await Client.connect(ann.gameId, ann.token);
    const welcome = await client.next("welcome");
    client.send({ t: "orders.default", p: { orders: [moves[ann.power]!] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stub = serverEnv.GAME_ROOM.get(serverEnv.GAME_ROOM.idFromName(ann.gameId));
    await runInDurableObject(stub, async (instance, state) => {
      (instance as unknown as { meta: { deadlineAt: number } }).meta.deadlineAt = Date.now() - 1;
      const meta = await state.storage.get<{ deadlineAt: number }>("meta");
      await state.storage.put("meta", { ...meta, deadlineAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() - 1);
      await instance.alarm();
    });
    const state = await client.next("state");
    expect(state.p.phase).toBe("F1901M");
    const destination = moves[ann.power]!.split(" - ")[1]!;
    const unitType = moves[ann.power]!.startsWith("F ") ? "F" : "A";
    expect(state.p.state.units[ann.power]).toContain(`${unitType} ${destination}`);
    expect(welcome.p.phase).toBe("S1901M");
  });

  it("accepts retreat orders and advances back into movement", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
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
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
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

  it("applies pacing presets and extends a deadline after two seats request once", async () => {
    const ann = await create("Ann", { pacing: "live", graceSeconds: 45, whisperBudget: 2 });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const summaryRes = await SELF.fetch(`http://cabal/api/games/${ann.gameId}`);
    const summary = await summaryRes.json() as { settings: { movementSeconds: number }; deadlineAt: number };
    expect(summary.settings.movementSeconds).toBe(600);
    const initialDeadline = summary.deadlineAt;
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    a.send({ t: "extend", id: "ext-a", p: { phase: "S1901M" } });
    expect((await a.next("extend.ack")).p).toMatchObject({ requests: 1, extended: false });
    b.send({ t: "extend", id: "ext-b", p: { phase: "S1901M" } });
    expect((await b.next("extend.ack")).p).toMatchObject({ requests: 2, extended: true });
    const deadline = await SELF.fetch(`http://cabal/api/games/${ann.gameId}`);
    expect((await deadline.json() as { deadlineAt: number }).deadlineAt).toBe(initialDeadline + 45_000);
    a.send({ t: "extend", p: { phase: "S1901M" } });
    expect((await a.next("error")).p.code).toBe("extension_used");
  });

  it("enforces the configured private press budget", async () => {
    const ann = await create("Ann", { aiFill: true, whisperBudget: 2 });
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
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
      await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${ann.token}` },
      });
      const client = await Client.connect(ann.gameId, ann.token);
      await client.next("welcome");
      client.send({ t: "press.send", p: { to: "FRANCE", body: "private message" } });
      expect((await client.next("error")).p.code).toBe(expected);
    }
  });

  it("takes over a seat after three missed movement phases", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const opening = await a.next("welcome");
    await b.next("welcome");
    const holds = opening.p.state.units[ann.power]!.map((unit) => `${unit} H`);
    for (const phase of ["S1901M", "F1901M", "S1902M"]) {
      a.send({ t: "orders.set", p: { phase, orders: holds } });
      await a.next("orders.ack");
      a.send({ t: "ready", p: { phase, ready: true } });
      if (phase !== "S1902M") b.send({ t: "ready", p: { phase, ready: true } });
      await a.next("state");
    }
    const summary = await (await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).json() as {
      seats: { power: string; kind: string; missed: number }[];
    };
    expect(summary.seats.find((seat) => seat.power === bob.power)).toMatchObject({ kind: "ai", missed: 3 });
  });

  it("allows a substitute to claim a civil-disorder seat with a fresh token", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    for (const phase of ["S1901M", "F1901M"]) {
      a.send({ t: "orders.set", p: { phase, orders: [] } });
      await a.next("orders.ack");
      a.send({ t: "ready", p: { phase, ready: true } });
      b.send({ t: "ready", p: { phase, ready: true } });
      await a.next("state");
    }
    const substituteRes = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/join`, {
      method: "POST",
      body: JSON.stringify({ name: "Sam", power: bob.power }),
    });
    expect(substituteRes.status).toBe(200);
    const substitute = await substituteRes.json() as { token: string; power: string };
    expect(substitute.power).toBe(bob.power);
    expect(substitute.token).not.toBe(bob.token);
    const oldToken = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/ws?token=${bob.token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(oldToken.status).toBe(401);
    const replacement = await Client.connect(ann.gameId, substitute.token);
    expect((await replacement.next("welcome")).p.power).toBe(bob.power);
  });

  it("abandons a game after three resolved phases without orders", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    for (const phase of ["S1901M", "F1901M", "S1902M"]) {
      a.send({ t: "orders.set", p: { phase, orders: [] } });
      await a.next("orders.ack");
      a.send({ t: "ready", p: { phase, ready: true } });
      if (phase !== "S1902M") b.send({ t: "ready", p: { phase, ready: true } });
      if (phase !== "S1902M") await a.next("state");
    }
    expect((await a.next("status")).p).toMatchObject({ status: "abandoned", reason: "no_orders" });
    const summary = await SELF.fetch(`http://cabal/api/games/${ann.gameId}`);
    expect((await summary.json() as { status: string }).status).toBe("abandoned");
  });

  it("pauses when every human disconnects and resumes on reconnect", async () => {
    const ann = await create("Ann", { aiFill: true });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    a.close();
    b.close();
    let status = "active";
    for (let i = 0; i < 20 && status !== "paused"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = ((await (await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).json()) as { status: string }).status;
    }
    expect(status).toBe("paused");
    const spectator = await Client.connect(ann.gameId);
    expect((await spectator.next("welcome")).p).toMatchObject({ status: "paused", pauseReason: "humans_absent" });
    const resumed = await Client.connect(ann.gameId, ann.token);
    expect((await resumed.next("welcome")).p.status).toBe("active");
  });

  it("distinguishes DIAS unanimity from a two-vote non-DIAS draw", async () => {
    for (const dias of [true, false]) {
      const ann = await create("Ann", { aiFill: true, dias });
      const bob = await join(ann.gameId, "Bob");
      const cal = await join(ann.gameId, "Cal");
      await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${ann.token}` },
      });
      const clients = await Promise.all([ann.token, bob.token, cal.token].map((token) => Client.connect(ann.gameId, token)));
      for (const client of clients) await client.next("welcome");
      clients[0]!.send({ t: "vote", p: { kind: "draw", value: true } });
      clients[1]!.send({ t: "vote", p: { kind: "draw", value: true } });
      if (!dias) await clients[0]!.next("finished");
      const summary = await SELF.fetch(`http://cabal/api/games/${ann.gameId}`);
      expect((await summary.json() as { status: string }).status).toBe(dias ? "active" : "finished");
      if (dias) {
        clients[2]!.send({ t: "vote", p: { kind: "draw", value: true } });
        expect((await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).status).toBe(200);
        expect(((await (await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).json()) as { status: string }).status).toBe("finished");
      }
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
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
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
    const state = await a.next("state");
    expect(state.p.phase).toBe("F1901M");
    expect([...state.p.state.units[ann.power]!].sort()).toEqual(annUnits);
    // Bob's legitimate default still stood in for his missing orders.
    expect(state.p.state.units[bob.power]).toContain(moves[bob.power]![1]);
  });

  it("lets a draw pass when the other human seat has fallen into civil disorder", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await SELF.fetch(`http://cabal/api/games/${ann.gameId}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${ann.token}` },
    });
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    const bobWelcome = await b.next("welcome");
    const bobUnits = bobWelcome.p.state.units[bob.power]!;
    // Bob readies up without orders twice, which puts his seat into civil disorder.
    for (const phase of ["S1901M", "F1901M"]) {
      a.send({ t: "orders.set", p: { phase, orders: [] } });
      await a.next("orders.ack");
      a.send({ t: "ready", p: { phase, ready: true } });
      b.send({ t: "ready", p: { phase, ready: true } });
      await a.next("state");
    }
    const summary = await (await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).json() as {
      seats: { power: string; kind: string; missed: number }[];
    };
    expect(summary.seats.find((seat) => seat.power === bob.power)).toMatchObject({ kind: "civil_disorder", missed: 2 });

    // A returning player can submit orders to reclaim the seat from civil disorder.
    b.send({ t: "orders.set", p: { phase: "S1902M", orders: bobUnits.map((unit) => `${unit} H`) } });
    const returned = await b.next("orders.ack");
    expect(returned.p.accepted).toHaveLength(bobUnits.length);
    const recoveredSummary = await (await SELF.fetch(`http://cabal/api/games/${ann.gameId}`)).json() as {
      seats: { power: string; kind: string; missed: number }[];
    };
    expect(recoveredSummary.seats.find((seat) => seat.power === bob.power)).toMatchObject({ kind: "human", missed: 0 });
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    const finished = await a.next("finished");
    expect(finished.p.result).toBe("draw");
    const indexed = await serverEnv.DB?.prepare("SELECT result, phase_count FROM games_index WHERE game_id = ?").bind(ann.gameId).first<{
      result: string;
      phase_count: number;
    }>();
    expect(indexed).toMatchObject({ result: "draw", phase_count: 2 });
  });

  it("throttles a socket that floods the room", async () => {
    const ann = await create("Ann");
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    for (let i = 0; i < 60; i++) spectator.send({ t: "sync", p: { since: 0 } });
    const error = await spectator.next("error");
    expect(error.p.code).toBe("rate_limited");
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

  it("rejects bad tokens and lets spectators watch", async () => {
    const ann = await create("Ann");
    const bad = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/ws?token=${ann.gameId}.FRANCE.${"0".repeat(48)}`, {
      headers: { upgrade: "websocket" },
    });
    expect(bad.status).toBe(401);
    const spectator = await Client.connect(ann.gameId);
    const welcome = await spectator.next("welcome");
    expect(welcome.p.power).toBeNull();
  });
});
