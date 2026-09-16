import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@cabal/protocol";

async function create(name: string, settings: Record<string, unknown> = {}) {
  const res = await SELF.fetch("http://cabal/api/games", {
    method: "POST",
    body: JSON.stringify({ name, settings }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { gameId: string; token: string; power: string };
}

async function join(gameId: string, name: string) {
  const res = await SELF.fetch(`http://cabal/api/games/${gameId}/join`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { gameId: string; token: string; power: string };
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
