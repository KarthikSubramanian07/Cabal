/**
 * A whole game, played the way the web app will play it: two people on real WebSockets through
 * `CabalSocket` and `createApi` from `@cabal/protocol/client`, five AI seats played by the bot,
 * from the lobby through movement, retreat and adjustment phases to an agreed draw.
 *
 * Nothing here reaches into the room. Everything the two players know arrived over the wire.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Game, pledgeCommit, pledgeOpens, randomNonce } from "@cabal/engine";
import type { GameRecord, PhaseSummary, PowerName, ReplayExtension, SeatView, ServerMessage, StateView } from "@cabal/protocol";
import { CabalSocket, type SocketLike, createApi } from "@cabal/protocol/client";
import { botOrders } from "../src/bot.js";
import { nextIp, until, untilIndexed } from "./helpers.js";

const api = createApi({
  baseUrl: "http://cabal",
  fetch: (input, init) => SELF.fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), "cf-connecting-ip": nextIp() } }),
});

/** Everything one player's client knows, built only from frames. */
class Table {
  status = "";
  phase = "";
  state: StateView | null = null;
  seats: SeatView[] = [];
  results: string[] = [];
  history: PhaseSummary[] = [];
  receipts: Extract<ServerMessage, { t: "pledge.receipt" }>["p"][] = [];
  finished: Extract<ServerMessage, { t: "finished" }>["p"] | null = null;
  press: string[] = [];
  votes: Extract<ServerMessage, { t: "votes" }>["p"] | null = null;
  /** Every numbered frame delivered, to prove each arrives once and in order. */
  seqs: number[] = [];
  replayed: string[] = [];
  welcomes = 0;
  /** While this is set, the socket's next connection attempt waits for it. */
  hold: Promise<void> | null = null;
  readonly socket: CabalSocket;

  constructor(gameId: string, token: string) {
    this.socket = new CabalSocket({
      token,
      heartbeatMs: 0,
      backoff: { minMs: 10, maxMs: 40 },
      connect: async (): Promise<SocketLike> => {
        if (this.hold) await this.hold;
        const res = await SELF.fetch(`http://cabal/api/games/${gameId}/ws`, { headers: { upgrade: "websocket", "cf-connecting-ip": nextIp() } });
        const ws = res.webSocket!;
        ws.accept();
        return ws as unknown as SocketLike;
      },
    });
    this.socket.on("frame", (frame, meta) => this.apply(frame, meta.replayed));
  }

  private apply(m: ServerMessage, replayed: boolean): void {
    if (m.seq !== undefined) this.seqs.push(m.seq);
    if (replayed) this.replayed.push(m.t);
    switch (m.t) {
      case "welcome":
        this.welcomes++;
        this.status = m.p.status;
        this.phase = m.p.phase;
        this.state = m.p.state;
        this.seats = m.p.seats;
        this.history = m.p.history;
        this.finished = m.p.finished;
        return;
      case "state":
        this.status = m.p.status;
        this.phase = m.p.phase;
        this.state = m.p.state;
        return;
      case "status":
        this.status = m.p.status;
        return;
      case "seats":
        this.seats = m.p.seats;
        return;
      case "results":
        this.results.push(m.p.phase);
        if (!this.history.some((h) => h.phase === m.p.phase)) this.history = [...this.history, m.p.summary];
        return;
      case "pledge.receipt":
        this.receipts.push(m.p);
        return;
      case "press":
        this.press.push(m.p.body);
        return;
      case "votes":
        this.votes = m.p;
        return;
      case "finished":
        this.finished = m.p;
        return;
      default:
        return;
    }
  }

  seat(power: string): SeatView {
    return this.seats.find((s) => s.power === power)!;
  }

  /** Legal orders for this player's own power, worked out on the client from the state it was sent. */
  orders(power: string, seed: string): string[] {
    const game = Game.fromState(this.state!);
    try {
      return botOrders(game, power, seed);
    } finally {
      game.free();
    }
  }
}

describe("a full game over the wire", () => {
  it("plays two humans and five AI seats from the lobby through adjustments to an agreed draw", { timeout: 120_000 }, async () => {
    // --- lobby ---
    const ann = await api.createGame({ name: "Ann", settings: { visibility: "public", readyAdvance: true, aiFill: true, scoring: "sos" } });
    const bob = await api.joinGame(ann.gameId, { name: "Bob" });
    expect(bob.power).not.toBe(ann.power);
    const a = new Table(ann.gameId, ann.token);
    const b = new Table(ann.gameId, bob.token);
    const [wa, wb] = await Promise.all([a.socket.start(), b.socket.start()]);
    expect(wa).toMatchObject({ status: "lobby", power: ann.power, host: ann.power });
    expect(wb).toMatchObject({ status: "lobby", power: bob.power, host: ann.power });
    await a.socket.press("ALL", "Good luck, Bob. The rest are automatons.");
    await until(async () => b.press.length === 1, "table talk to reach Bob");
    await until(async () => a.seat(bob.power).present && b.seat(ann.power).present, "both players to see each other connected");
    expect((await api.listLive("open")).some((g) => g.gameId === ann.gameId && g.humans === 2)).toBe(true);

    const begun = await api.startGame(ann.gameId, ann.token);
    expect(begun.status).toBe("active");
    await until(async () => a.status === "active" && b.status === "active" && a.seats.filter((s) => s.kind === "ai").length === 5, "the game to start");
    expect(a.seats.filter((s) => s.kind === "ai").every((s) => s.brain === "bot" && s.present && s.submitted && s.ready)).toBe(true);

    // --- a sealed pledge the audience can check for itself ---
    const annFirst = a.orders(ann.power, "ann");
    const pledged = [annFirst[0]!];
    const nonce = randomNonce();
    const commitment = pledgeCommit(pledged, nonce);
    const sent = await a.socket.press(bob.power, "I am sealing my first order for you.", { orders: pledged, sealed: true, nonce, commitment });
    expect(sent.p.pledge).toMatchObject({ commitment, nonce, orders: pledged });

    // --- play ---
    const players = [
      { table: a, seat: ann, seed: "ann" },
      { table: b, seat: bob, seed: "bob" },
    ];
    let dropped = false;
    for (let turn = 0; turn < 14; turn++) {
      const phase = a.phase;
      // Both clients agree on where the game is before anybody moves.
      await until(async () => b.phase === phase && b.socket.status === "open", `Bob to reach ${phase}`);
      // Play on until a full year, adjustments included, is behind us.
      if (phase.endsWith("M") && a.results.some((p) => p.endsWith("A"))) break;
      const acting = players.filter((p) => p.table.seat(p.seat.power).canAct);
      for (const p of acting) {
        const orders = p.table.orders(p.seat.power, p.seed);
        expect(orders.length, `${p.seed} has orders in ${phase}`).toBeGreaterThan(0);
        const ack = await p.table.socket.setOrders(phase, orders);
        // The client's own engine and the server's judge agree: every order is accepted.
        expect(ack.p.verdicts.filter((v) => !v.ok)).toEqual([]);
        expect(ack.p.accepted).toHaveLength(orders.length);
      }
      if (acting.length === 0) {
        // Only AI seats have anything to do, and they are ready the moment the phase opens.
        await until(async () => a.phase !== phase, `${phase} to resolve by itself`);
        continue;
      }
      await until(async () => acting.every((p) => a.seat(p.seat.power).submitted), "the table to see the orders are in");

      const bobActs = acting.some((p) => p.seat === bob);
      const annActs = acting.some((p) => p.seat === ann);
      if (!dropped && phase === "F1901M" && bobActs && annActs) {
        // Bob readies, then loses his connection, and the phase resolves while he is away.
        dropped = true;
        b.socket.ready(phase);
        await until(async () => a.seat(bob.power).ready, "Ann to see Bob ready");
        let release!: () => void;
        b.hold = new Promise<void>((resolve) => (release = resolve));
        const cursor = b.socket.seq;
        b.socket.reconnect();
        await until(async () => !a.seat(bob.power).present, "Ann to see Bob gone");
        a.socket.ready(phase);
        await until(async () => a.phase !== phase, `${phase} to resolve`);
        expect(b.phase).toBe(phase);
        expect(b.results).not.toContain(phase);
        // He comes back and is brought up to date: what he missed is replayed, then the snapshot.
        b.hold = null;
        release();
        await until(async () => b.socket.status === "open" && b.phase === a.phase, "Bob to catch up");
        expect(b.welcomes).toBe(2);
        expect(b.replayed).toEqual(expect.arrayContaining(["results", "state"]));
        expect(b.results).toContain(phase);
        expect(b.socket.seq).toBeGreaterThan(cursor);
        continue;
      }
      for (const p of acting) p.table.socket.ready(phase);
      await until(async () => a.phase !== phase || a.finished !== null, `${phase} to resolve`);
    }

    // --- what was played: every phase either client saw resolve, in order ---
    const played = a.results;
    expect(played.slice(0, 2)).toEqual(["S1901M", "F1901M"]);
    expect(played.some((p) => p.endsWith("A")), `an adjustment phase in ${played.join(" ")}`).toBe(true);
    expect(dropped).toBe(true);
    expect(a.phase.endsWith("M")).toBe(true);
    expect(new Set(played).size).toBe(played.length);
    expect(b.results).toEqual(played);
    expect(a.history.map((h) => h.phase)).toEqual(played);
    // Bob's client saw every numbered frame once, in order, across the reconnect.
    expect(b.seqs).toEqual([...new Set(b.seqs)].sort((x, y) => x - y));
    expect(a.seqs).toEqual([...new Set(a.seqs)].sort((x, y) => x - y));
    // The automatons played: after a year somebody has taken a neutral centre and built for it.
    const centres = a.history.at(-1)!.centers;
    expect(Object.values(centres).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(22);
    const units = Object.values(a.state!.units).reduce((sum, list) => sum + list.length, 0);
    expect(units).toBeGreaterThan(22);

    // --- the pledge: stamped, and verifiable by Bob without trusting the server ---
    const receipt = b.receipts.find((r) => r.pledgeId === sent.p.pledge!.id)!;
    expect(receipt).toMatchObject({ receipt: "kept", revealed: pledged, nonce });
    expect(pledgeOpens(commitment, receipt.revealed!, receipt.nonce)).toBe(true);

    // --- a legitimate finish: both players agree to a draw ---
    expect((await api.listLive("active")).some((g) => g.gameId === ann.gameId && g.phase === a.phase)).toBe(true);
    a.socket.vote(true);
    await until(async () => b.votes?.cast === 1 && b.votes.yes === 1, "Bob to see Ann's vote");
    expect(b.votes!.draw).toEqual([{ power: ann.power, value: true, include: null }]);
    b.socket.vote(true);
    await until(async () => a.finished !== null && b.finished !== null, "the game to finish");
    expect(a.finished).toMatchObject({ result: "draw", reason: "vote" });
    expect(b.finished).toEqual(a.finished);
    expect(a.status).toBe("finished");
    const scores = a.finished!.scores;
    expect(Object.values(scores).reduce((sum, v) => sum + v, 0)).toBeCloseTo(1, 6);
    expect(a.finished!.winners.sort()).toEqual(Object.keys(centres).filter((p) => centres[p]! > 0).sort());
    // Sum of Squares: the biggest power takes the biggest share.
    const leader = Object.keys(centres).sort((x, y) => centres[y]! - centres[x]!)[0]! as PowerName;
    expect(scores[leader]).toBe(Math.max(...Object.values(scores)));

    // --- afterwards: the summary, the ledger, the replay and the index all tell the same story ---
    const summary = await api.summary(ann.gameId);
    expect(summary).toMatchObject({ status: "finished", host: ann.power, finished: { result: "draw", reason: "vote" } });
    expect(summary.history.map((h) => h.phase)).toEqual(played);
    const ledger = await api.ledger(ann.gameId);
    expect(ledger.ledger[ann.power]).toEqual({ kept: 1, broken: 0, void: 0 });
    expect(ledger.entries).toHaveLength(1);
    expect(pledgeOpens(ledger.entries[0]!.commitment, ledger.entries[0]!.orders, ledger.entries[0]!.nonce)).toBe(true);
    const replay = await api.replay(ann.gameId);
    const saved = Game.fromSaved(JSON.stringify(replay));
    expect(saved.state()).toEqual(a.state);
    saved.free();
    expect((replay.cabal as ReplayExtension).pledges).toEqual(ledger.entries);
    expect((replay.cabal as ReplayExtension).history).toEqual(summary.history);
    const record: GameRecord = await untilIndexed(ann.gameId);
    expect(record).toMatchObject({ result: "draw", reason: "vote", phaseCount: played.length, scores });
    expect(record.seats.filter((s) => s.kind === "ai")).toHaveLength(5);
    await until(async () => !(await api.listLive("active")).some((g) => g.gameId === ann.gameId), "the game to leave the live list");
    expect((await api.listFinished({ limit: 100 })).some((g) => g.gameId === ann.gameId)).toBe(true);

    // A late reconnect lands on the finished game, with nothing left to replay twice.
    const late = new Table(ann.gameId, bob.token);
    expect(await late.socket.start()).toMatchObject({ status: "finished", finished: { result: "draw" } });
    for (const table of [a, b, late]) table.socket.close();
  });
});
