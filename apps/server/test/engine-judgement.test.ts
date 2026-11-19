/**
 * What the room takes from the engine: board-judged verdicts with their finer reason, pledges
 * checked against the board, receipts judged on the board the phase started from, and results
 * frames that keep everything the engine explains.
 */
import { describe, expect, it } from "vitest";
import { Game } from "@cabal/engine";
import { ServerMessage } from "@cabal/protocol";
import { Client, POWERS, create, inRoom, join, sql, start } from "./helpers.js";

/** A started game whose board is replaced by `units`, with Ann connected. */
async function arranged(units: (ann: string, enemy: string) => Record<string, string[]>) {
  const ann = await create("Ann", { aiFill: true });
  const bob = await join(ann.gameId, "Bob");
  await start(ann);
  const enemy = POWERS.find((p) => p !== ann.power && p !== bob.power)!;
  const state = new Game().state();
  state.units = units(ann.power, enemy);
  await inRoom(ann.gameId, async (room, storage) => {
    const game = Game.fromState(state);
    (room as unknown as { game: Game }).game = game;
    await storage.storage.put("saved", game.toSaved(ann.gameId));
  });
  const a = await Client.connect(ann.gameId, ann.token);
  const b = await Client.connect(ann.gameId, bob.token);
  await a.next("welcome");
  await b.next("welcome");
  return { ann, bob, enemy, a, b };
}

describe("verdicts from the engine", () => {
  it("names the engine's own reason beside the coarse code", async () => {
    const { a } = await arranged((ann, enemy) => ({ [ann]: ["A PAR", "F BRE"], [enemy]: ["A MUN"] }));
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: ["A PAR - MOS", "F BRE - PAR", "A PAR S A PAR", "A MUN - BUR", "A PAR - BUR", "A PAR - PIC"] } });
    const ack = await a.next("orders.ack");
    expect(ack.p.verdicts.map((v) => [v.code, v.detail ?? null])).toEqual([
      // Illegal on their own, so judged on their own: a bad line never displaces a good one.
      ["illegal", "unreachable"],
      ["illegal", "unreachable"],
      ["illegal", "support_self"],
      ["no_such_unit", "foreign_unit"],
      // Two good orders for one unit: the last one sent stands.
      ["superseded", "duplicate_order"],
      ["ok", null],
    ]);
    expect(ack.p.accepted).toEqual(["A PAR - PIC"]);
    expect(ack.p.verdicts[1]!.reason).toMatch(/\.$/);
  });
});

describe("pledges and receipts from the engine", () => {
  it("refuses a pledge about a unit the pledger does not command, or an order it cannot be given", async () => {
    const { a, bob, enemy } = await arranged((ann, enemy) => ({ [ann]: ["A PAR"], [enemy]: ["A MUN"] }));
    a.send({ t: "press.send", id: "p1", p: { to: bob.power, body: "promise", pledge: { orders: ["A MUN H"] } } });
    expect((await a.next("error", (m) => m.id === "p1")).p.code).toBe("bad_pledge");
    a.send({ t: "press.send", id: "p2", p: { to: bob.power, body: "promise", pledge: { orders: ["A PAR - MOS"] } } });
    expect((await a.next("error", (m) => m.id === "p2")).p.code).toBe("bad_pledge");
    expect(enemy).not.toBe(bob.power);
  });

  it("stamps a pledge broken when its pledger had units and ordered nothing", async () => {
    const { a, b, ann, bob } = await arranged((ann, enemy) => ({ [ann]: ["A PAR"], [enemy]: ["A MUN"] }));
    a.send({ t: "press.send", p: { to: bob.power, body: "I hold Paris.", pledge: { orders: ["A PAR H"] } } });
    await b.next("press");
    // Ann sends nothing at all; Bob readies, and the deadline would do the rest.
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const receipt = await b.next("pledge.receipt");
    expect(receipt.p.receipt).toBe("broken");
    expect(await sql<{ receipt: string }>(ann.gameId, "SELECT receipt FROM pledges")).toEqual([{ receipt: "broken" }]);
  });

  it("stamps a pledge kept when the pledged order was on file, however it was spelled", async () => {
    const { a, b, bob } = await arranged((ann, enemy) => ({ [ann]: ["A PAR"], [enemy]: ["A MUN"] }));
    a.send({ t: "press.send", p: { to: bob.power, body: "To Burgundy.", pledge: { orders: ["a par - bur"] } } });
    await b.next("press");
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: ["A PAR - BUR"] } });
    await a.next("orders.ack");
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    expect((await b.next("pledge.receipt")).p).toMatchObject({ receipt: "kept", revealed: ["A PAR - BUR"] });
  });
});

describe("results frames", () => {
  it("keep the engine's summary, the units behind a failure and the rejected list", async () => {
    const { a, b, ann: seat } = await arranged((ann, enemy) => ({ [ann]: ["A PAR"], [enemy]: ["A BUR"] }));
    const ann = seat.power;
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: ["A PAR - BUR"] } });
    await a.next("orders.ack");
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const raw = await a.next("results");
    // Parsed the way a client parses it: nothing the engine said is stripped.
    const frame = ServerMessage.parse(raw) as typeof raw;
    // The AI seats' orders were filed for the board before it was rearranged: the engine rejects
    // them by name rather than dropping them silently.
    expect(frame.p.rejected!.length).toBeGreaterThan(0);
    expect(frame.p.rejected!.every((r) => r.power !== ann && r.code.length > 0 && r.input.length > 0)).toBe(true);
    const move = frame.p.results.find((r) => r.power === ann)!;
    expect(move).toMatchObject({ unit: "A PAR", ok: false, code: "repelled" });
    expect(move.summary).toMatch(/A BUR/);
    expect(move.by).toEqual(["A BUR"]);
  });
});
