import { type PressView, type SeatView, ServerMessage, resolveSettings } from "@cabal/protocol";
import type { Frame } from "@cabal/protocol/client";
import { describe, expect, it } from "vitest";
import { applyFrame, canStart, fromSummary, humanSeats, openSeats } from "./room.js";
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
});
