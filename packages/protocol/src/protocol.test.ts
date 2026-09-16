import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  GameSettings,
  ServerMessage,
  drawSize,
  parseClientMessage,
  ratingCluster,
  sumOfSquares,
} from "./index.js";

describe("settings", () => {
  it("applies defaults", () => {
    const s = GameSettings.parse({});
    expect(s.rulebook).toBe("2023");
    expect(s.press).toBe("full");
    expect(s.movementSeconds).toBe(86400);
    expect(ratingCluster(s)).toBe("standard:full:async");
  });
});

describe("client frames", () => {
  it("accepts a valid orders frame", () => {
    const m = parseClientMessage({
      t: "orders.set",
      id: "1",
      p: { phase: "S1901M", orders: ["A PAR - BUR"] },
    });
    expect(m?.t).toBe("orders.set");
  });

  it("rejects unknown types and bad phases", () => {
    expect(parseClientMessage({ t: "nope", p: {} })).toBeNull();
    expect(
      parseClientMessage({ t: "orders.set", p: { phase: "X1901M", orders: [] } }),
    ).toBeNull();
  });

  it("requires a nonce shape for sealed pledges when given", () => {
    const ok = ClientMessage.safeParse({
      t: "press.send",
      p: {
        to: "GERMANY",
        body: "I will support you into Denmark.",
        pledge: { orders: ["A MUN S F KIE - DEN"], sealed: true, nonce: "00".repeat(16) },
      },
    });
    expect(ok.success).toBe(true);
    const bad = ClientMessage.safeParse({
      t: "press.send",
      p: { to: "GERMANY", body: "x", pledge: { orders: [], sealed: true, nonce: "zz" } },
    });
    expect(bad.success).toBe(false);
  });
});

describe("server frames", () => {
  it("validates a finished frame", () => {
    const r = ServerMessage.safeParse({
      t: "finished",
      p: { result: "draw", winners: ["FRANCE", "GERMANY"], scores: { FRANCE: 0.5, GERMANY: 0.5 } },
    });
    expect(r.success).toBe(true);
  });
});

describe("scoring", () => {
  it("sum of squares favours the leader", () => {
    const s = sumOfSquares({ FRANCE: 12, GERMANY: 12, ITALY: 6, TURKEY: 0 });
    expect(s["FRANCE"]).toBeCloseTo(144 / 324);
    expect(s["TURKEY"]).toBe(0);
  });

  it("draw size splits equally among survivors", () => {
    const s = drawSize({ FRANCE: 12, GERMANY: 12, ITALY: 6, TURKEY: 0 });
    expect(s["FRANCE"]).toBeCloseTo(1 / 3);
    expect(s["TURKEY"]).toBe(0);
  });
});
