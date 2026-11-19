import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  GameRecord,
  GameSettings,
  PACING_PRESETS,
  ServerMessage,
  drawSize,
  parseClientMessage,
  ratingCluster,
  resolveSettings,
  sumOfSquares,
} from "./index.js";

describe("settings", () => {
  it("applies defaults", () => {
    const s = GameSettings.parse({});
    expect(s.rulebook).toBe("2023");
    expect(s.press).toBe("full");
    expect(s.movementSeconds).toBe(172800);
    expect(s.shortPhaseSeconds).toBe(86400);
    expect(s.graceSeconds).toBe(900);
    expect(s.whisperBudget).toBeNull();
    expect(s.rulebookPress).toBe(false);
    expect(s.aiBrain).toBe("bot");
    expect(ratingCluster(s)).toBe("standard:full:async");
  });

  it("fills the clock from the pacing preset", () => {
    for (const pacing of ["live", "daily", "async"] as const) {
      const s = resolveSettings({ pacing });
      expect(s).toMatchObject(PACING_PRESETS[pacing]);
    }
    expect(resolveSettings({ pacing: "live" }).movementSeconds).toBe(600);
    expect(resolveSettings({ pacing: "daily" }).shortPhaseSeconds).toBe(43_200);
    expect(resolveSettings({}).pacing).toBe("async");
  });

  it("lets explicit seconds override the preset", () => {
    const s = resolveSettings({ pacing: "live", movementSeconds: 120, graceSeconds: 0 });
    expect(s.movementSeconds).toBe(120);
    expect(s.graceSeconds).toBe(0);
    expect(s.shortPhaseSeconds).toBe(300);
  });

  it("rejects settings that do not validate", () => {
    expect(() => resolveSettings({ pacing: "hourly" as never })).toThrow();
    expect(() => resolveSettings({ movementSeconds: 5 })).toThrow();
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

  it("validates a paused status update with its bounded timeout", () => {
    const r = ServerMessage.safeParse({
      t: "status",
      p: { status: "paused", reason: "humans_absent", until: 1_800_000_000_000 },
    });
    expect(r.success).toBe(true);
  });

  it("validates an abandoned game, a votes frame and a pending extension", () => {
    expect(
      ServerMessage.safeParse({ t: "finished", p: { result: "abandoned", winners: [], scores: {}, reason: "no_orders" } }).success,
    ).toBe(true);
    expect(
      ServerMessage.safeParse({
        t: "votes",
        p: { phase: "S1901M", draw: [{ power: "FRANCE", value: true, include: null }], required: ["FRANCE", "ITALY"] },
      }).success,
    ).toBe(true);
    expect(
      ServerMessage.safeParse({
        t: "extend",
        p: { phase: "S1901M", requestedBy: ["FRANCE"], needed: 2, granted: false, deadlineAt: 1 },
      }).success,
    ).toBe(true);
  });
});

describe("draw votes", () => {
  it("accepts a named subset and rejects an empty one", () => {
    expect(parseClientMessage({ t: "vote", p: { kind: "draw", value: true, include: ["FRANCE", "ITALY"] } })?.t).toBe("vote");
    expect(parseClientMessage({ t: "vote", p: { kind: "draw", value: true, include: [] } })).toBeNull();
    expect(parseClientMessage({ t: "vote", p: { kind: "draw", value: true } })?.t).toBe("vote");
  });
});

describe("registry records", () => {
  it("validates an abandoned game record", () => {
    const record = GameRecord.safeParse({
      gameId: "ABC234",
      result: "abandoned",
      reason: "no_orders",
      winners: [],
      scores: {},
      settings: GameSettings.parse({}),
      cluster: "standard:full:async",
      phaseCount: 3,
      createdAt: 1,
      finishedAt: 2,
      ledger: { FRANCE: { kept: 1, broken: 0, void: 0 } },
      seats: [{ power: "FRANCE", kind: "human", name: "Ann", centers: 3, eliminated: false }],
    });
    expect(record.success).toBe(true);
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
