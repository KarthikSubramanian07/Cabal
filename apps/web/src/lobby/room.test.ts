import { type PressView, type SeatView, ServerMessage, resolveSettings } from "@cabal/protocol";
import type { Frame } from "@cabal/protocol/client";
import { describe, expect, it } from "vitest";
import { afterSummaryFailure, applyFrame, canStart, fromSummary, humanSeats, markThreadRead, openSeats } from "./room.js";
import { POWERS } from "./terms.js";

const STATE = { name: "S1901M", units: {}, centers: {}, homes: {}, retreats: {}, builds: {} };

function seats(humans: Partial<Record<string, string>>): SeatView[] {
  return POWERS.map((power) => ({
    power,
    kind: humans[power] ? "human" : "open",
    name: humans[power] ?? null,
    ready: false,
    eliminated: false,
    missed: 0,
    brain: null,
    present: Boolean(humans[power]),
    submitted: false,
    canAct: false,
    host: power === "FRANCE",
  }));
}

function press(id: string, sentAt: number, body = "Hello"): PressView {
  return { id, phase: "LOBBY", from: "FRANCE", to: "ALL", body, sentAt, pledge: null };
}

/** Every frame used here is checked against the real schema, so the fixtures cannot drift. */
function frame(raw: unknown): Frame {
  return ServerMessage.parse(raw);
}

function welcome(over: Record<string, unknown> = {}): Frame {
  return frame({
    t: "welcome",
    p: {
      protocol: 2,
      gameId: "K7Q2XZ",
      settings: resolveSettings({ pacing: "live" }),
      status: "lobby",
      power: null,
      host: "FRANCE",
      phase: "S1901M",
      state: STATE,
      seats: seats({ FRANCE: "Ada" }),
      deadlineAt: null,
      serverTime: 2_000,
      seq: 3,
      orders: [],
      defaults: [],
      press: [press("m1", 10)],
      pressMore: false,
      unread: {},
      votes: { phase: "S1901M", draw: [], required: [], hidden: false, cast: 0, yes: 0 },
      history: [],
      finished: null,
      ...over,
    },
  });
}

describe("the room view", () => {
  it("takes everything from a welcome", () => {
    const view = applyFrame(null, welcome(), 1_000)!;
    expect(view.gameId).toBe("K7Q2XZ");
    expect(view.host).toBe("FRANCE");
    expect(view.power).toBeNull();
    expect(view.press.map((m) => m.id)).toEqual(["m1"]);
    expect(view.clockOffsetMs).toBe(1_000);
    expect(openSeats(view)).toHaveLength(6);
    expect(humanSeats(view).map((s) => s.name)).toEqual(["Ada"]);
  });

  it("adds each message once, in the order it was sent", () => {
    let view = applyFrame(null, welcome(), 0);
    view = applyFrame(view, frame({ t: "press", seq: 4, p: press("m3", 30) }), 0);
    view = applyFrame(view, frame({ t: "press", seq: 5, p: press("m2", 20) }), 0);
    view = applyFrame(view, frame({ t: "press", seq: 6, p: press("m3", 30) }), 0);
    expect(view!.press.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // A reconnect's welcome keeps what is already on screen.
    view = applyFrame(view, welcome({ press: [press("m1", 10), press("m4", 40)], power: "ITALY" }), 0);
    expect(view!.press.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(view!.power).toBe("ITALY");
  });

  it("follows seats, the start of the game and the clock", () => {
    let view = applyFrame(null, welcome(), 0);
    view = applyFrame(view, frame({ t: "seats", p: { seats: seats({ FRANCE: "Ada", ITALY: "Bea" }) } }), 0);
    expect(humanSeats(view!).map((s) => s.power)).toEqual(["FRANCE", "ITALY"]);
    view = applyFrame(view, frame({ t: "status", seq: 7, p: { status: "active", reason: null } }), 0);
    expect(view!.status).toBe("active");
    view = applyFrame(view, frame({ t: "deadline", seq: 8, p: { phase: "S1901M", deadlineAt: 9_000, serverTime: 500 } }), 100);
    expect(view!.deadlineAt).toBe(9_000);
    expect(view!.clockOffsetMs).toBe(400);
    view = applyFrame(view, frame({ t: "finished", seq: 9, p: { result: "abandoned", winners: [], scores: {}, reason: "no_humans" } }), 0);
    expect(view!.status).toBe("abandoned");
  });

  it("ignores frames that arrive before a picture exists, and frames it does not draw", () => {
    expect(applyFrame(null, frame({ t: "seats", p: { seats: [] } }), 0)).toBeNull();
    const view = applyFrame(null, welcome(), 0);
    expect(applyFrame(view, frame({ t: "error", p: { code: "x", message: "y" } }), 0)).toBe(view);
  });

  it("starts from the summary until the socket speaks", () => {
    const view = fromSummary(
      {
        id: "K7Q2XZ",
        settings: resolveSettings({}),
        status: "lobby",
        phase: "S1901M",
        host: "FRANCE",
        deadlineAt: null,
        serverTime: 50,
        createdAt: 0,
        seats: seats({ FRANCE: "Ada" }),
        finished: null,
        pauseReason: null,
        pausedUntil: null,
        pausedRemainingMs: null,
        history: [],
        ai: {
          brain: "bot",
          model: null,
          claudeTurns: 0,
          claudeCalls: 0,
          spentUsd: 0,
          capUsd: 0,
          tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopped: null,
        },
      },
      20,
    );
    expect(view.state).toBeNull();
    expect(view.clockOffsetMs).toBe(30);
  });

  it("lets the host start only when the table allows it", () => {
    const filling = { seats: seats({ FRANCE: "Ada" }), status: "lobby" as const };
    expect(canStart({ ...filling, settings: resolveSettings({ aiFill: true }) })).toEqual({ ok: true, why: null });
    expect(canStart({ ...filling, settings: resolveSettings({ aiFill: false }) }).why).toBe("6 seats are still open, and this table waits for players.");
    expect(canStart({ ...filling, status: "active", settings: resolveSettings({}) }).ok).toBe(false);
  });

  it("keeps the seat's orders on file, and starts each new phase with none", () => {
    let view = applyFrame(null, welcome({ status: "active", power: "FRANCE", orders: ["A PAR H"] }), 0)!;
    expect(view.orders).toEqual(["A PAR H"]);
    view = applyFrame(view, frame({ t: "orders.ack", id: "c2", p: { phase: "S1901M", accepted: ["A PAR - BUR"], rejected: [], verdicts: [] } }), 0)!;
    expect(view.orders).toEqual(["A PAR - BUR"]);
    // An acknowledgement for a phase that has gone is not this phase's orders.
    expect(applyFrame(view, frame({ t: "orders.ack", p: { phase: "W1900A", accepted: [], rejected: [], verdicts: [] } }), 0)).toBe(view);
    view = applyFrame(view, frame({ t: "state", seq: 9, p: { phase: "F1901M", state: { ...STATE, name: "F1901M" }, deadlineAt: 5, serverTime: 0, seq: 9, status: "active" } }), 0)!;
    expect(view.orders).toEqual([]);
    expect(view.ordersPhase).toBe("F1901M");
  });

  it("remembers a phase's results with the board it began on, and clears the phase's votes", () => {
    let view = applyFrame(null, welcome({ status: "active", votes: { phase: "S1901M", draw: [{ power: "FRANCE", value: true, include: null }], required: ["FRANCE"], hidden: false, cast: 1, yes: 1 } }), 0)!;
    const summary = { phase: "S1901M", adjudicatedAt: 1, centers: { FRANCE: 3 } };
    view = applyFrame(
      view,
      frame({
        t: "results",
        seq: 4,
        p: { phase: "S1901M", results: [{ power: "FRANCE", unit: "A PAR", order: "A PAR - BUR", ok: true, code: "ok", reason: "" }], dislodged: [], standoffs: [], civil_disorder: [], summary, seq: 4 },
      }),
      0,
    )!;
    expect(view.lastResolved).toBe("S1901M");
    expect(view.resolved["S1901M"]!.before).toEqual(STATE);
    expect(view.history).toEqual([summary]);
    expect(view.votes).toMatchObject({ draw: [], cast: 0, yes: 0 });
  });

  it("stamps a receipt on its pledge, and never lets an older copy take the stamp away", () => {
    const pledge = { id: "p1", pledger: "FRANCE", audience: "ITALY", phase: "S1901M", sealed: true, commitment: "c".repeat(64), orders: null, receipt: null, nonce: null };
    const message = { id: "m9", phase: "S1901M", from: "FRANCE", to: "ITALY", body: "Trust me", sentAt: 50, pledge } as PressView;
    let view = applyFrame(null, welcome({ status: "active", power: "ITALY", press: [message] }), 0)!;
    view = applyFrame(view, frame({ t: "pledge.receipt", seq: 5, p: { pledgeId: "p1", receipt: "kept", revealed: ["A PAR H"], nonce: "a".repeat(32) } }), 0)!;
    expect(view.press[0]!.pledge).toMatchObject({ receipt: "kept", orders: ["A PAR H"], nonce: "a".repeat(32) });
    // A reconnect replays the message as it was sent, before the stamp.
    view = applyFrame(view, welcome({ status: "active", power: "ITALY", press: [message] }), 0)!;
    expect(view.press[0]!.pledge?.receipt).toBe("kept");
  });

  it("counts unread messages from others, and takes the server's counts when it sends them", () => {
    let view = applyFrame(null, welcome({ status: "active", power: "ITALY", unread: { ALL: 1 } }), 0)!;
    view = applyFrame(view, frame({ t: "press", seq: 4, p: { id: "x1", phase: "S1901M", from: "FRANCE", to: "ITALY", body: "psst", sentAt: 60, pledge: null } }), 0)!;
    view = applyFrame(view, frame({ t: "press", seq: 5, p: { id: "x2", phase: "S1901M", from: "ITALY", to: "FRANCE", body: "yes?", sentAt: 61, pledge: null } }), 0)!;
    expect(view.unread).toEqual({ ALL: 1, FRANCE: 1 });
    expect(markThreadRead(view, "FRANCE").unread.FRANCE).toBe(0);
    view = applyFrame(view, frame({ t: "press.unread", p: { unread: { ALL: 0 } } }), 0)!;
    expect(view.unread).toEqual({ ALL: 0 });
  });

  it("follows the grace period, extensions and the end of the game", () => {
    let view = applyFrame(null, welcome({ status: "active", deadlineAt: 100 }), 0)!;
    view = applyFrame(view, frame({ t: "deadline", seq: 4, p: { phase: "S1901M", deadlineAt: 160, serverTime: 0, grace: true } }), 0)!;
    expect(view.grace).toBe(true);
    view = applyFrame(view, frame({ t: "extend", seq: 5, p: { phase: "S1901M", requestedBy: ["FRANCE"], needed: 2, granted: false, deadlineAt: null } }), 0)!;
    expect(view.extend).toEqual({ phase: "S1901M", requestedBy: ["FRANCE"], needed: 2, granted: false });
    expect(view.deadlineAt).toBe(160);
    view = applyFrame(view, frame({ t: "finished", seq: 6, p: { result: "draw", winners: ["FRANCE"], scores: { FRANCE: 1 }, reason: "vote" } }), 0)!;
    expect(view).toMatchObject({ status: "finished", deadlineAt: null, finished: { result: "draw", reason: "vote" } });
  });
});

describe("a summary that fails", () => {
  type Load = { kind: "loading" } | { kind: "missing" } | { kind: "unreachable"; message: string } | { kind: "ready"; view: string };
  const down: Load = { kind: "unreachable", message: "The game server is not answering." };

  it("leaves the room the socket's welcome already drew", () => {
    const ready: Load = { kind: "ready", view: "the board" };
    expect(afterSummaryFailure<Load>(ready, down)).toBe(ready);
    expect(afterSummaryFailure<Load>(ready, { kind: "missing" })).toBe(ready);
  });

  it("is the page when nothing has answered yet", () => {
    expect(afterSummaryFailure<Load>({ kind: "loading" }, down)).toBe(down);
    expect(afterSummaryFailure<Load>({ kind: "loading" }, { kind: "missing" })).toEqual({ kind: "missing" });
  });
});
