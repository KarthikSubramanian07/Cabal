/**
 * AgentClient against an in-memory socket hub that relays press the way the server does.
 * The bug this guards against: agents that decided the instant a phase opened never read a word
 * the other powers wrote, so every pledge was made to nobody.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentClient } from "./client.js";
import { type Brain, type Decision, Player } from "./player.js";
import type { DecisionRecord } from "./record.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

type Listener = (event: { data?: string }) => void;

/** One phase of a game, with the press routing of the real room and nothing else. */
class Hub {
  sockets = new Map<string, FakeSocket>();
  received: { power: string; frame: { t: string; p: Record<string, unknown> } }[] = [];
  private seq = 0;
  private press: { from: string; to: string }[] = [];
  constructor(
    readonly state = new Game().state(),
    readonly deadlineAt: number | null = null,
    readonly pressMode = "full",
  ) {}

  socketClass(): typeof WebSocket {
    const make = (): Hub => this;
    return class extends FakeSocket {
      constructor() {
        super(make());
      }
    } as unknown as typeof WebSocket;
  }

  handle(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as { t: string; p: Record<string, unknown> };
    if (frame.t === "hello") {
      const power = String(frame.p["token"]).split(".")[1]!;
      socket.power = power;
      this.sockets.set(power, socket);
      socket.deliver({
        t: "welcome",
        p: {
          gameId: "TEST01",
          settings: { press: this.pressMode },
          status: "active",
          power,
          phase: "S1901M",
          state: this.state,
          seats: [],
          deadlineAt: this.deadlineAt,
          seq: 0,
          orders: [],
          // Like the room, a welcome carries the press this seat may read.
          press: this.press.filter((m) => m.to === "ALL" || m.to === power || m.from === power),
        },
      });
      return;
    }
    this.received.push({ power: socket.power, frame });
    if (frame.t === "press.send") {
      const to = String(frame.p["to"]);
      const pledge = frame.p["pledge"] as { orders: string[]; sealed: boolean } | undefined;
      const view = {
        id: `p${++this.seq}`,
        phase: "S1901M",
        from: socket.power,
        to,
        body: frame.p["body"],
        sentAt: this.seq,
        pledge: pledge
          ? { id: `g${this.seq}`, pledger: socket.power, audience: to, phase: "S1901M", sealed: pledge.sealed, commitment: "c", orders: pledge.orders, receipt: null }
          : null,
      };
      this.press.push(view);
      for (const [power, other] of this.sockets) {
        if (to === "ALL" || power === to || power === socket.power) other.deliver({ t: "press", p: view });
      }
    }
  }

  of(power: string, t: string) {
    return this.received.filter((r) => r.power === power && r.frame.t === t).map((r) => r.frame.p);
  }
}

class FakeSocket {
  power = "";
  private listeners: Record<string, Listener[]> = {};
  constructor(private hub: Hub) {
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  send(raw: string): void {
    this.hub.handle(this, raw);
  }
  deliver(frame: unknown): void {
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(frame) }));
  }
  close(): void {}
}

const reply = (over: Partial<Decision>): Decision => ({ reasoning: "", orders: [], messages: [], pledge: null, relationships: [], diary: "", ...over });

/** A brain that talks in the negotiate step and holds in the order step, recording its prompts. */
function talker(power: string, to: string, hold: string) {
  const prompts: { step: string; prompt: string }[] = [];
  const brain: Brain = {
    async decide(request) {
      prompts.push({ step: request.step, prompt: request.prompt });
      const decision =
        request.step === "negotiate"
          ? reply({ orders: [hold], messages: [{ to, body: `${power} proposes peace` }], pledge: { to, orders: [hold], sealed: false }, diary: "Proposed." })
          : reply({ orders: [hold], diary: "Ordered." });
      return { decision, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-opus-5-5" };
    },
  };
  return { brain, prompts };
}

/** A sleep the test opens by hand, so "the others have had time to reply" is exact, not timed. */
function gate() {
  const waits: number[] = [];
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { waits, open, sleep: (ms: number) => (waits.push(ms), opened) };
}

async function seat(hub: Hub, power: string, brain: Brain, options: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) {
  const decisions: DecisionRecord[] = [];
  const client = new AgentClient({
    serverUrl: "http://hub",
    gameId: "TEST01",
    token: `TEST01.${power}.secret`,
    player: new Player(power, "x", brain),
    WebSocketImpl: hub.socketClass(),
    onDecision: (record) => decisions.push(record),
    ...options,
  });
  await client.connect();
  return { client, decisions };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("AgentClient", () => {
  it("reads the other powers' press of the phase before it orders", async () => {
    const hub = new Hub();
    const g = gate();
    const france = talker("FRANCE", "GERMANY", "A PAR H");
    const germany = talker("GERMANY", "FRANCE", "A MUN H");
    const f = await seat(hub, "FRANCE", france.brain, { sleep: g.sleep });
    const d = await seat(hub, "GERMANY", germany.brain, { sleep: g.sleep });
    await settle();
    // Both have spoken and neither has ordered: they are listening.
    expect(hub.of("FRANCE", "press.send")).toHaveLength(1);
    expect(hub.of("GERMANY", "press.send")).toHaveLength(1);
    expect(hub.of("FRANCE", "orders.set")).toHaveLength(0);
    expect(g.waits).toEqual([15_000, 15_000]);
    g.open();
    await Promise.all([f.client.awaitTurn(), d.client.awaitTurn()]);
    await settle();
    // The order step saw what the other side wrote, pledge included, and its own pledge.
    const final = france.prompts.find((p) => p.step === "order")!.prompt;
    expect(final).toContain('GERMANY -> FRANCE: "GERMANY proposes peace" [pledge: A MUN H]');
    expect(final).toContain("# Your pledges this phase\nA PAR H");
    expect(germany.prompts.find((p) => p.step === "order")!.prompt).toContain('FRANCE -> GERMANY: "FRANCE proposes peace"');
    // The opening step had nothing to read yet, which is the old behaviour for the whole turn.
    expect(france.prompts[0]).toMatchObject({ step: "negotiate" });
    expect(france.prompts[0]!.prompt).toContain("# Press this phase\nnone");
    // Orders and ready go out once, after the order step.
    expect(hub.of("FRANCE", "orders.set")).toEqual([{ phase: "S1901M", orders: ["A PAR H"] }]);
    expect(hub.of("FRANCE", "ready")).toEqual([{ phase: "S1901M", ready: true }]);
    // Every decision is logged with its phase, power, step, tokens and cost.
    expect(f.decisions.map((r) => [r.phase, r.power, r.step, r.fallback, r.costMicros, r.usage?.outputTokens])).toEqual([
      ["S1901M", "FRANCE", "negotiate", false, 140, 5],
      ["S1901M", "FRANCE", "order", false, 140, 5],
    ]);
    expect(f.decisions[1]!.orders).toEqual(["A PAR H"]);
    expect(f.decisions[0]!.prompt).toContain("You are FRANCE");
  });

  it("never listens past the deadline", async () => {
    const now = 1_000_000;
    // 13 seconds left, 5 kept back for the order step: a quarter of the remaining 8.
    const hub = new Hub(undefined, now + 13_000);
    const g = gate();
    const { client } = await seat(hub, "FRANCE", talker("FRANCE", "GERMANY", "A PAR H").brain, { sleep: g.sleep, now: () => now });
    await settle();
    expect(g.waits).toEqual([2000]);
    g.open();
    await client.awaitTurn();
    // With the deadline already on top of it, it does not wait at all.
    const late = new Hub(undefined, now + 3000);
    const g2 = gate();
    const second = await seat(late, "FRANCE", talker("FRANCE", "GERMANY", "A PAR H").brain, { sleep: g2.sleep, now: () => now });
    await second.client.awaitTurn();
    await settle();
    expect(g2.waits).toEqual([]);
    expect(late.of("FRANCE", "orders.set")).toHaveLength(1);
  });

  it("plays one silent step in a gunboat game", async () => {
    const hub = new Hub(undefined, null, "gunboat");
    const france = talker("FRANCE", "GERMANY", "A PAR H");
    const { client, decisions } = await seat(hub, "FRANCE", france.brain);
    await client.awaitTurn();
    await settle();
    expect(decisions.map((d) => d.step)).toEqual(["order"]);
    expect(hub.of("FRANCE", "press.send")).toHaveLength(0);
    expect(hub.of("FRANCE", "orders.set")).toHaveLength(1);
  });

  it("plays nothing after its last year, so an arena can stop a game there", async () => {
    const hub = new Hub();
    const france = talker("FRANCE", "GERMANY", "A PAR H");
    const { client, decisions } = await seat(hub, "FRANCE", france.brain, { lastYear: 1900 });
    await client.awaitTurn();
    await settle();
    expect(decisions).toEqual([]);
    expect(france.prompts).toEqual([]);
    expect(hub.received.filter((r) => r.power === "FRANCE")).toEqual([]);
    // Up to and including the last year it plays as usual.
    const open = new Hub();
    const played = await seat(open, "FRANCE", talker("FRANCE", "GERMANY", "A PAR H").brain, { lastYear: 1901, negotiate: false });
    await played.client.awaitTurn();
    await settle();
    expect(open.of("FRANCE", "orders.set")).toHaveLength(1);
  });

  it("holds and stays connected when the model fails", async () => {
    const hub = new Hub();
    const { client, decisions } = await seat(hub, "FRANCE", { decide: async () => Promise.reject(new Error("down")) }, { negotiate: false });
    await client.awaitTurn();
    await settle();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ fallback: true, costMicros: 0 });
    expect((hub.of("FRANCE", "orders.set")[0] as { orders: string[] }).orders.sort()).toEqual(["A MAR H", "A PAR H", "F BRE H"]);
  });
});
