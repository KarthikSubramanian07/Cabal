import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { predict } from "../game/explain/whatIf.js";
import { legalForEveryone, sameOrders, sketchCount, sketchGhosts, sketchMarks, sketchPowers, sketchSyncLine } from "./sketch.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

describe("legalForEveryone", () => {
  it("lists every power's legal orders, not only the seat's", () => {
    const all = legalForEveryone(new Game(), "M");
    expect(Object.keys(all.legal).sort()).toEqual(["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]);
    expect(all.legal.FRANCE?.["A PAR"]).toContain("A PAR - BUR");
    expect(all.legal.GERMANY?.["A MUN"]).toContain("A MUN - BUR");
  });

  it("lists builds under the empty key with each power's allowance in a winter", () => {
    const g = new Game();
    g.process({ orders: { FRANCE: ["A PAR - PIC", "F BRE - MAO", "A MAR - SPA"] } });
    g.process({ orders: { FRANCE: ["A PIC - BEL", "F MAO - POR", "A SPA H"] } });
    const all = legalForEveryone(g, "A");
    expect(all.allowance.FRANCE).toBe(3);
    expect(all.legal.FRANCE?.[""]).toContain("A PAR B");
    expect(sketchPowers(all, "GERMANY", "A")).toEqual(["GERMANY", "FRANCE"]);
  });
});

describe("the sketch on the board", () => {
  it("marks each sketched order with its predicted result, and ghosts the moves that would succeed", () => {
    const book = { FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR - SPA" }, GERMANY: { "A MUN": "A MUN - BUR" } };
    const prediction = predict(new Game().state(), book);
    const marks = sketchMarks(book, prediction);
    expect(marks).toContainEqual({ power: "FRANCE", text: "A PAR - BUR", ok: false });
    expect(marks).toContainEqual({ power: "GERMANY", text: "A MUN - BUR", ok: false });
    expect(marks).toContainEqual({ power: "FRANCE", text: "A MAR - SPA", ok: true });
    expect(sketchGhosts(prediction)).toEqual([{ power: "FRANCE", kind: "A", region: "SPA" }]);
    expect(sketchCount(book)).toBe(3);
  });

  it("puts the seat first and only the powers with something to order after it", () => {
    const all = legalForEveryone(new Game(), "M");
    const list = sketchPowers(all, "TURKEY", "M");
    expect(list[0]).toBe("TURKEY");
    expect(list.slice(1)).toEqual(["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA"]);
  });
});

describe("sketchSyncLine", () => {
  it("says nothing when the real orders landed", () => {
    expect(sketchSyncLine(null, 0)).toBeNull();
  });
  it("says a filing failed, while the sketch is still open", () => {
    expect(sketchSyncLine("The phase has moved on.", 0)).toBe("Your real orders were not filed: The phase has moved on.");
  });
  it("counts the real orders the server refused", () => {
    expect(sketchSyncLine(null, 1)).toBe("One of your real orders was refused. Leave what if to see why.");
    expect(sketchSyncLine(null, 3)).toBe("3 of your real orders were refused. Leave what if to see why.");
  });
});

describe("sameOrders", () => {
  const opened = { "A PAR": "A PAR - BUR", "F BRE": "F BRE - MAO" };
  it("is true for the same orders in any order of keys", () => {
    expect(sameOrders(opened, { "F BRE": "F BRE - MAO", "A PAR": "A PAR - BUR" })).toBe(true);
    expect(sameOrders({}, {})).toBe(true);
  });
  it("notices an order changed, added or taken back on another device", () => {
    expect(sameOrders(opened, { "A PAR": "A PAR - PIC", "F BRE": "F BRE - MAO" })).toBe(false);
    expect(sameOrders(opened, { ...opened, "A MAR": "A MAR H" })).toBe(false);
    expect(sameOrders(opened, { "A PAR": "A PAR - BUR" })).toBe(false);
  });
});
