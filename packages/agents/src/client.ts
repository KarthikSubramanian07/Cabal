/**
 * An agent is just another client: it joins over the same WebSocket protocol as a
 * human, computes its own legal orders with the engine, and submits orders, press
 * and pledges through the same frames.
 */
import { Game, type MapInfo, mapInfo } from "@cabal/engine";
import type { PressView, ServerMessage, StateView } from "@cabal/protocol";
import type { Player } from "./player.js";

export interface AgentClientOptions {
  /** e.g. wss://cabal-server.example.workers.dev */
  serverUrl: string;
  gameId: string;
  token: string;
  player: Player;
  /** Called with every decision for logs and evals. */
  onDecision?: (phase: string, info: { orders: string[]; dropped: { text: string; reason: string }[] }) => void;
  /** WebSocket constructor; defaults to the global one. */
  WebSocketImpl?: typeof WebSocket;
}

export class AgentClient {
  private ws: WebSocket | null = null;
  private press: PressView[] = [];
  private trust: Record<string, { kept: number; broken: number }> = {};
  private phase = "";
  private state: StateView | null = null;
  private map: MapInfo | null = null;
  private busy = false;

  constructor(private opts: AgentClientOptions) {}

  connect(): Promise<void> {
    const url = `${this.opts.serverUrl.replace(/^http/, "ws")}/api/games/${this.opts.gameId}/ws?token=${this.opts.token}`;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(url);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
      ws.addEventListener("message", (ev) => void this.onFrame(JSON.parse(String(ev.data)) as ServerMessage));
    });
  }

  close(): void {
    this.ws?.close();
  }

  private send(frame: unknown): void {
    this.ws?.send(JSON.stringify(frame));
  }

  private async onFrame(m: ServerMessage): Promise<void> {
    switch (m.t) {
      case "welcome":
        this.phase = m.p.phase;
        this.state = m.p.state;
        this.press = m.p.press;
        this.map ??= mapInfo();
        if (m.p.status === "active") await this.act();
        return;
      case "state":
        this.phase = m.p.phase;
        this.state = m.p.state;
        this.press = this.press.filter((p) => p.phase === m.p.phase);
        await this.act();
        return;
      case "press":
        this.press.push(m.p);
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

  /** Decide and submit for the current phase. */
  private async act(): Promise<void> {
    if (this.busy || !this.state || !this.map) return;
    this.busy = true;
    try {
      const power = this.opts.player.power;
      const game = Game.fromState(this.state);
      const legal = game.legal(power);
      if (Object.keys(legal.by_unit).length === 0) {
        this.send({ t: "ready", p: { phase: this.phase, ready: true } });
        return;
      }
      const { validated, decision } = await this.opts.player.play({
        phase: this.phase,
        state: this.state,
        map: this.map,
        legal,
        press: this.press
          .filter((p) => p.phase === this.phase)
          .map((p) => ({ from: p.from, to: p.to, body: p.body, pledge: p.pledge?.orders ?? null })),
        myPledges: this.press
          .filter((p) => p.phase === this.phase && p.from === power && p.pledge?.orders)
          .map((p) => p.pledge!.orders!),
        trust: this.trust,
      });
      this.opts.onDecision?.(this.phase, validated);
      for (const msg of decision.messages) {
        const pledge =
          decision.pledge && decision.pledge.to === msg.to
            ? { orders: decision.pledge.orders.filter((o) => validated.orders.includes(o)), sealed: decision.pledge.sealed }
            : undefined;
        this.send({
          t: "press.send",
          p: { to: msg.to, body: msg.body, ...(pledge && pledge.orders.length ? { pledge } : {}) },
        });
      }
      this.send({ t: "orders.set", p: { phase: this.phase, orders: validated.orders } });
      this.send({ t: "ready", p: { phase: this.phase, ready: true } });
    } finally {
      this.busy = false;
    }
  }
}
