import { type PledgeView, type PowerName, type PressView, resolveSettings } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import type { RoomView } from "../lobby/room.js";
import { LINE_CHARS, pinDispatches, roomDispatches } from "./dispatches.js";

function view(over: Partial<RoomView> = {}): RoomView {
  return {
    gameId: "K7Q2XZ",
    settings: resolveSettings({ pacing: "live" }),
    status: "active",
    host: "FRANCE",
    phase: "S1901M",
    state: null,
    seats: [],
    deadlineAt: null,
    grace: false,
    pauseReason: null,
    power: "FRANCE",
    press: [],
    pressMore: false,
    unread: {},
    orders: [],
    ordersPhase: "S1901M",
    votes: null,
    history: [],
    resolved: {},
    lastResolved: null,
    extend: null,
    clockOffsetMs: 0,
    finished: null,
    ...over,
  };
}

let clock = 0;
function msg(from: PowerName, to: PowerName | "ALL", body = "Hello", pledge: PledgeView | null = null): PressView {
  clock += 1;
  return { id: `m${clock}`, phase: "S1901M", from, to, body, sentAt: clock, pledge };
}

function pledge(pledger: PowerName, audience: PowerName | "ALL", receipt: PledgeView["receipt"] = null): PledgeView {
  return { id: `p-${pledger}-${audience}`, pledger, audience, phase: "S1901M", sealed: true, commitment: "ab".repeat(32), nonce: null, orders: null, receipt };
}

const me = { me: "FRANCE" as PowerName, reading: null };

describe("press slips", () => {
  it("bring news of a message for a thread that is not on screen", () => {
    const letter = msg("ENGLAND", "FRANCE", "Meet me in the Channel?");
    const out = roomDispatches(view(), view({ press: [letter] }), me);
    expect(out).toEqual([
      expect.objectContaining({ key: "press:ENGLAND", kind: "press", power: "ENGLAND", title: "Dispatch from England", line: "Meet me in the Channel?", thread: "ENGLAND", count: 1, say: "New dispatch from England." }),
    ]);
  });

  it("stay away while the player is reading that very thread, but not another one", () => {
    const letter = msg("ENGLAND", "FRANCE");
    expect(roomDispatches(view(), view({ press: [letter] }), { me: "FRANCE", reading: "ENGLAND" })).toEqual([]);
    expect(roomDispatches(view(), view({ press: [letter] }), { me: "FRANCE", reading: "ALL" })).toHaveLength(1);
  });

  it("never announce the player's own words, or a message already seen", () => {
    const mine = msg("FRANCE", "ENGLAND");
    const old = msg("ENGLAND", "FRANCE");
    expect(roomDispatches(view({ press: [old] }), view({ press: [old, mine] }), me)).toEqual([]);
  });

  it("gather several messages of one thread into one slip, and say the table's talk as the table's", () => {
    const a = msg("ENGLAND", "FRANCE", "One");
    const b = msg("ENGLAND", "FRANCE", "Two");
    const c = msg("TURKEY", "ALL", "To all.");
    const out = roomDispatches(view(), view({ press: [a, b, c] }), me);
    expect(out.map((d) => [d.key, d.title, d.line, d.count])).toEqual([
      ["press:ENGLAND", "2 dispatches from England", "Two", 2],
      ["press:ALL", "Turkey to the table", "To all.", 1],
    ]);
  });

  it("show a spectator the table, threaded by sender", () => {
    const c = msg("TURKEY", "ALL", "To all.");
    expect(roomDispatches(view({ power: null }), view({ power: null, press: [c] }), { me: null, reading: null })[0]?.thread).toBe("ALL");
  });

  it("clip a long message to one short line", () => {
    const long = msg("ENGLAND", "FRANCE", `${"word ".repeat(80)}end`);
    const line = roomDispatches(view(), view({ press: [long] }), me)[0]!.line;
    expect([...line].length).toBeLessThanOrEqual(LINE_CHARS);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("receipt slips", () => {
  it("come when a seal the player could see is stamped, once", () => {
    const sealed = msg("ENGLAND", "FRANCE", "Trust me.", pledge("ENGLAND", "FRANCE"));
    const stamped = { ...sealed, pledge: { ...sealed.pledge!, receipt: "broken" as const, orders: ["F LON - ENG"] } };
    const out = roomDispatches(view({ press: [sealed] }), view({ press: [stamped] }), me);
    expect(out).toEqual([expect.objectContaining({ kind: "receipt", title: "England's seal to you", say: expect.stringMatching(/^England's seal to you: broken\. /), stamp: "broken", thread: "ENGLAND", power: "ENGLAND" })]);
    expect(roomDispatches(view({ press: [stamped] }), view({ press: [stamped] }), me)).toEqual([]);
  });

  it("name the player's own seal as theirs, even while its thread is open", () => {
    const sealed = msg("FRANCE", "ALL", "Peace.", pledge("FRANCE", "ALL"));
    const kept = { ...sealed, pledge: { ...sealed.pledge!, receipt: "kept" as const } };
    const out = roomDispatches(view({ press: [sealed] }), view({ press: [kept] }), { me: "FRANCE", reading: "ALL" });
    expect(out.map((d) => d.title)).toEqual(["Your seal to the table"]);
  });
});

describe("phase slips", () => {
  const results = [
    { power: "FRANCE", unit: "A PAR", order: "A PAR - BUR", ok: false, code: "bounce", reason: "bounce" },
    { power: "FRANCE", unit: "F BRE", order: "F BRE - MAO", ok: true, code: "ok", reason: "" },
    { power: "ENGLAND", unit: "F LON", order: "F LON - ENG", ok: true, code: "ok", reason: "" },
  ] as unknown as RoomView["resolved"][string]["results"];
  const resolved = { S1901M: { phase: "S1901M", results, dislodged: [], standoffs: [], civil_disorder: [], summary: {} as never, before: null } };

  it("say a phase resolved and how the player's own orders fared, without speaking over the room", () => {
    const out = roomDispatches(view(), view({ resolved, lastResolved: "S1901M" }), me);
    expect(out).toEqual([expect.objectContaining({ key: "resolved", title: "Spring 1901, movement resolved", line: "1 of your 2 orders failed.", say: null })]);
  });

  it("tell a spectator to look at the board", () => {
    const out = roomDispatches(view({ power: null }), view({ power: null, resolved, lastResolved: "S1901M" }), { me: null, reading: null });
    expect(out[0]?.line).toBe("The results are on the board.");
  });

  it("is not repeated for the same phase, nor raised across two different games", () => {
    expect(roomDispatches(view({ lastResolved: "S1901M", resolved }), view({ lastResolved: "S1901M", resolved }), me)).toEqual([]);
    expect(roomDispatches(view({ gameId: "AAAAAA" }), view({ resolved, lastResolved: "S1901M" }), me)).toEqual([]);
  });
});

describe("pinning slips", () => {
  const slip = (key: string, kind: "press" | "resolved" = "press", count = 1) =>
    ({ key, kind, power: "ENGLAND", title: key, line: key, stamp: null, thread: kind === "press" ? (key.split(":")[1] as "ENGLAND") : null, count, say: null }) as const;

  it("adds news about a thread to its slip and moves it to the top", () => {
    const up = [slip("press:ENGLAND"), slip("resolved", "resolved")];
    const next = pinDispatches(up, [{ ...slip("press:ENGLAND"), line: "newest" }]);
    expect(next.map((d) => d.key)).toEqual(["resolved", "press:ENGLAND"]);
    expect(next[1]).toMatchObject({ count: 2, title: "2 dispatches from England", line: "newest" });
  });

  it("keeps only the newest few up", () => {
    const next = pinDispatches([], [slip("press:A"), slip("press:B"), slip("press:C"), slip("press:D")], 3);
    expect(next.map((d) => d.key)).toEqual(["press:B", "press:C", "press:D"]);
  });
});
