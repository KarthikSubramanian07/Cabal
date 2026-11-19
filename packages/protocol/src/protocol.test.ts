import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  DatcReport,
  GameRecord,
  MetricsBeacon,
  PushSubscriptionRequest,
  UpdateNotificationPreferences,
  GameSettings,
  PACING_PRESETS,
  ServerMessage,
  drawScores,
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
    expect(s).toMatchObject({ scoring: "sos", visibility: "unlisted", publicVotes: true });
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
        p: { phase: "S1901M", draw: [{ power: "FRANCE", value: true, include: null }], required: ["FRANCE", "ITALY"], hidden: false, cast: 1, yes: 1 },
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

describe("scoring rule", () => {
  it("shares a draw by the game's scoring: squares, or equal parts among the sharers", () => {
    const centers = { FRANCE: 12, GERMANY: 6, ITALY: 0 };
    expect(drawScores("sos", centers)).toEqual(sumOfSquares(centers));
    expect(drawScores("dss", centers)).toEqual({ FRANCE: 0.5, GERMANY: 0.5, ITALY: 0 });
  });
});

describe("envelope", () => {
  it("carries an optional seq on every server frame and refuses a seq below one", () => {
    expect(ServerMessage.safeParse({ t: "status", seq: 12, p: { status: "active", reason: null } }).success).toBe(true);
    expect(ServerMessage.safeParse({ t: "status", p: { status: "active", reason: null } }).success).toBe(true);
    expect(ServerMessage.safeParse({ t: "status", seq: 0, p: { status: "active", reason: null } }).success).toBe(false);
    expect(ServerMessage.safeParse({ t: "synced", p: { seq: 0, more: false, gap: true } }).success).toBe(true);
  });

  it("validates table talk, a read marker, a verdict and a receipt that opens its seal", () => {
    expect(
      ServerMessage.safeParse({ t: "press", seq: 3, p: { id: "a", phase: "LOBBY", from: "FRANCE", to: "ALL", body: "hello", sentAt: 1, pledge: null } }).success,
    ).toBe(true);
    expect(parseClientMessage({ t: "press.read", p: { with: "ALL", upTo: 10 } })?.t).toBe("press.read");
    expect(parseClientMessage({ t: "press.read", p: { with: "NOBODY", upTo: 10 } })).toBeNull();
    expect(
      ServerMessage.safeParse({
        t: "orders.ack",
        p: { phase: "S1901M", accepted: [], rejected: [{ text: "A PAR - MOS", reason: "no" }], verdicts: [{ text: "A PAR - MOS", order: "A PAR - MOS", ok: false, code: "illegal", reason: "no" }] },
      }).success,
    ).toBe(true);
    expect(ServerMessage.safeParse({ t: "pledge.receipt", p: { pledgeId: "x", receipt: "kept", revealed: ["A PAR H"] } }).success).toBe(false);
    expect(ServerMessage.safeParse({ t: "pledge.receipt", p: { pledgeId: "x", receipt: "kept", revealed: ["A PAR H"], nonce: "00".repeat(16) } }).success).toBe(true);
    expect(ClientMessage.safeParse({ t: "press.send", p: { to: "ALL", body: "x", pledge: { orders: ["A PAR H"], commitment: "nope" } } }).success).toBe(false);
  });
});

describe("notifications and metrics", () => {
  it("takes a browser's PushSubscription.toJSON() as it is", () => {
    const fromChrome = {
      endpoint: "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH",
      expirationTime: null,
      keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    };
    expect(PushSubscriptionRequest.parse(fromChrome)).toEqual(fromChrome);
    expect(PushSubscriptionRequest.safeParse({ ...fromChrome, keys: { p256dh: "short", auth: "x" } }).success).toBe(false);
  });

  it("changes at least one preference at a time", () => {
    expect(UpdateNotificationPreferences.safeParse({}).success).toBe(false);
    expect(UpdateNotificationPreferences.parse({ press: false })).toEqual({ press: false });
    expect(UpdateNotificationPreferences.safeParse({ press: "no" }).success).toBe(false);
  });

  it("accepts only bounded, anonymous timings from a browser", () => {
    expect(MetricsBeacon.parse({ samples: [{ metric: "order_rtt", ms: 81.5 }, { metric: "landing_to_game", ms: 41_000 }] }).samples).toHaveLength(2);
    for (const bad of [{ samples: [] }, { samples: [{ metric: "order_rtt", ms: -1 }] }, { samples: [{ metric: "order_rtt", ms: 61_000 }] }, { samples: [{ metric: "datc", ms: 1 }] }]) {
      expect(MetricsBeacon.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(MetricsBeacon.safeParse({ samples: Array.from({ length: 51 }, () => ({ metric: "order_rtt", ms: 1 })) }).success).toBe(false);
  });

  it("names the commit a DATC report is for", () => {
    expect(DatcReport.safeParse({ passed: 171, failed: 0, skipped: 0, commit: "a582be1" }).success).toBe(true);
    expect(DatcReport.safeParse({ passed: 171, failed: 0, skipped: 0, commit: "main" }).success).toBe(false);
  });
});
