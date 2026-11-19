/**
 * An agent is just another client: it joins over the same WebSocket protocol as a human, computes
 * its own legal orders with the engine, and submits orders, press and pledges through the same
 * frames.
 *
 * A movement phase is played in two steps, because Diplomacy is a conversation:
 *
 *   1. negotiate: read the press so far, send proposals and at most one pledge;
 *   2. listen for a bounded while, so the other powers' press can arrive;
 *   3. order: read everything said this phase, then submit final orders and ready up.
 *
 * The wait is bounded by the phase deadline, so an agent never talks its way past the clock.
 * Retreat and adjustment phases, and games without press, are a single order step.
 */
import { Game, type MapInfo, mapInfo } from "@cabal/engine";
import type { PressView, ServerMessage, StateView } from "@cabal/protocol";
import type { Played, Player } from "./player.js";
import { type Step, phaseKind } from "./prompt.js";
import { type DecisionRecord, decisionRecord } from "./record.js";

export interface AgentClientOptions {
  /** e.g. wss://cabal-server.example.workers.dev */
  serverUrl: string;
  gameId: string;
  token: string;
  player: Player;
  /** Called with every decision for logs and evals: one decisions-log entry per step. */
  onDecision?: (record: DecisionRecord) => void;
  /** WebSocket constructor; defaults to the global one. */
  WebSocketImpl?: typeof WebSocket;
  /** False plays every phase in one step, without the opening round of press. Default true. */
  negotiate?: boolean;
  /** Longest wait between the two steps, in milliseconds. Default 15 seconds. */
  listenMs?: number;
  /** Time kept back before the deadline for the order step itself. Default 5 seconds. */
  orderReserveMs?: number;
  /** Injectable clock, for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Press kept for context across phases; older messages are dropped. */
const PRESS_KEPT = 400;
/** Messages one decision may send. */
const MESSAGES_PER_STEP = 4;

export class AgentClient {
  private ws: WebSocket | null = null;
  private press: PressView[] = [];
  private trust: Record<string, { kept: number; broken: number }> = {};
  private phase = "";
  private state: StateView | null = null;
  private deadlineAt: number | null = null;
  private pressMode: "full" | "public" | "gunboat" = "full";
  private map: MapInfo | null = null;
  private busy = false;
  private turnComplete = false;
  private turnWaiters: (() => void)[] = [];

  constructor(private opts: AgentClientOptions) {}

  connect(): Promise<void> {
    // The seat token never goes in the URL (URLs are logged): it is the first frame on the socket.
    const url = `${this.opts.serverUrl.replace(/^http/, "ws")}/api/games/${this.opts.gameId}/ws`;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ t: "hello", p: { token: this.opts.token } }));
        resolve();
      });
      ws.addEventListener("error", (e) => reject(e));
      ws.addEventListener("message", (ev) => {
        let frame: ServerMessage;
        try {
          frame = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return; // not ours to crash on
        }
        // A failed turn must never take the connection down with an unhandled rejection.
        this.onFrame(frame).catch(() => this.completeTurn());
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  /** Resolve after this connection has submitted its current phase's orders. */
  awaitTurn(): Promise<void> {
    if (this.turnComplete) return Promise.resolve();
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  /** The pledge receipts this client has seen, per pledger. */
  ledger(): Record<string, { kept: number; broken: number }> {
    return structuredClone(this.trust);
  }

  private send(frame: unknown): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private async onFrame(m: ServerMessage): Promise<void> {
    switch (m.t) {
      case "welcome":
        // Every socket is first welcomed as a spectator; the seat's own welcome follows the hello.
        if (m.p.power !== this.opts.player.power) return;
        this.phase = m.p.phase;
        this.state = m.p.state;
        this.deadlineAt = m.p.deadlineAt;
        this.pressMode = m.p.settings.press;
        this.press = m.p.press.slice(-PRESS_KEPT);
        this.map ??= mapInfo();
        if (m.p.status === "active") await this.act();
        else this.completeTurn();
        return;
      case "state":
        this.phase = m.p.phase;
        this.state = m.p.state;
        this.deadlineAt = m.p.deadlineAt;
        this.turnComplete = false;
        await this.act();
        return;
      case "deadline":
        if (m.p.phase === this.phase) this.deadlineAt = m.p.deadlineAt;
        return;
      case "press":
        // Kept across phases: last season's conversation is context for this season's.
        if (!this.press.some((p) => p.id === m.p.id)) this.press = [...this.press, m.p].slice(-PRESS_KEPT);
        return;
      case "status":
        if (m.p.status !== "active") this.completeTurn();
        return;
      case "finished":
        this.completeTurn();
        return;
      case "pledge.receipt": {
        const pledge = this.press.find((p) => p.pledge?.id === m.p.pledgeId)?.pledge;
        if (pledge) {
          const t = (this.trust[pledge.pledger] ??= { kept: 0, broken: 0 });
          if (m.p.receipt === "kept") t.kept++;
          if (m.p.receipt === "broken") t.broken++;
        }
        return;
      }
      default:
        return;
    }
  }

  /** One step for `phase`, with the press as it stands at this moment. */
  private step(phase: string, step: Step, state: StateView, legal: ReturnType<Game["legal"]>): Promise<Played> {
    const power = this.opts.player.power;
    return this.opts.player.play({
      phase,
      step,
      state,
      map: this.map!,
      legal,
      press: this.press
        .filter((p) => p.phase === phase)
        .map((p) => ({ from: p.from, to: p.to, body: p.body, pledge: p.pledge?.orders ?? null })),
      earlierPress: this.press
        .filter((p) => p.phase !== phase && (p.from === power || p.to === power))
        .map((p) => ({ phase: p.phase, from: p.from, to: p.to, body: p.body })),
      myPledges: this.press
        .filter((p) => p.phase === phase && p.from === power && p.pledge?.orders)
        .map((p) => p.pledge!.orders!),
      trust: this.trust,
    });
  }

  private report(phase: string, played: Played): void {
    this.opts.onDecision?.(decisionRecord(phase, this.opts.player.power, played));
  }

  private sendPress(played: Played): void {
    if (this.pressMode === "gunboat") return;
    const { decision, validated } = played;
    let pledged = false;
    for (const msg of decision.messages.slice(0, MESSAGES_PER_STEP)) {
      const to = msg.to.trim().toUpperCase();
      const body = msg.body.trim().slice(0, 1000);
      if (!body || to === this.opts.player.power) continue;
      if (this.pressMode === "public" && to !== "ALL") continue;
      const orders =
        !pledged && decision.pledge && decision.pledge.to.trim().toUpperCase() === to
          ? decision.pledge.orders.map((o) => o.trim().toUpperCase()).filter((o) => validated.orders.includes(o))
          : [];
      if (orders.length > 0) pledged = true;
      this.send({
        t: "press.send",
        p: { to, body, ...(orders.length > 0 ? { pledge: { orders, sealed: decision.pledge!.sealed } } : {}) },
      });
    }
  }

  /** How long to listen between the two steps: bounded by the option and by the deadline. */
  private listenFor(): number {
    const limit = this.opts.listenMs ?? 15_000;
    if (this.deadlineAt === null) return limit;
    const left = this.deadlineAt - (this.opts.now ?? Date.now)() - (this.opts.orderReserveMs ?? 5_000);
    return Math.max(0, Math.min(limit, Math.floor(left / 4)));
  }

  /** Play the current phase. */
  private async act(): Promise<void> {
    if (this.busy || !this.state || !this.map) return;
    this.busy = true;
    // Everything below answers for this phase, even if the server moves on mid-decision.
    const phase = this.phase;
    const state = this.state;
    try {
      const game = Game.fromState(state);
      let legal: ReturnType<Game["legal"]>;
      try {
        legal = game.legal(this.opts.player.power);
      } finally {
        game.free();
      }
      const nothingToDo =
        phaseKind(phase) === "A" ? legal.allowance === 0 : Object.values(legal.by_unit).every((menu) => menu.length === 0);
      if (nothingToDo) {
        this.send({ t: "ready", p: { phase, ready: true } });
        return;
      }
      const talks = this.opts.negotiate !== false && phaseKind(phase) === "M" && this.pressMode !== "gunboat";
      if (talks) {
        const opening = await this.step(phase, "negotiate", state, legal);
        if (this.phase !== phase) return;
        this.report(phase, opening);
        this.sendPress(opening);
        const wait = this.listenFor();
        if (wait > 0) await (this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
        if (this.phase !== phase) return;
      }
      const final = await this.step(phase, "order", state, legal);
      // The phase resolved while the model was thinking: these orders are stale, so drop them.
      if (this.phase !== phase) return;
      this.report(phase, final);
      this.sendPress(final);
      this.send({ t: "orders.set", p: { phase, orders: final.validated.orders } });
      this.send({ t: "ready", p: { phase, ready: true } });
    } finally {
      this.busy = false;
      this.completeTurn();
      // A state frame for a new phase arrived while busy and was skipped; act on it now.
      if (this.phase !== phase) void this.act().catch(() => this.completeTurn());
    }
  }

  private completeTurn(): void {
    this.turnComplete = true;
    for (const resolve of this.turnWaiters.splice(0)) resolve();
  }
}
