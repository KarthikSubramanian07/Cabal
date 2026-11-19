import { describe, expect, it } from "vitest";
import { eraseOrder, flatten, keepLegal, toBook, waiveBuild, writeOrder } from "./book.js";

describe("writeOrder", () => {
  const winter = { kind: "A" as const, allowance: 1 };

  it("refuses a second build when one is owed", () => {
    const one = writeOrder({}, "FRANCE", "B:MAR", "A MAR B", winter);
    const two = writeOrder(one, "FRANCE", "B:PAR", "A PAR B", winter);
    expect(two).toBe(one);
    expect(flatten(two)).toEqual({ FRANCE: ["A MAR B"] });
  });

  it("lets an order already written be changed", () => {
    const one = writeOrder({}, "FRANCE", "B:MAR", "A MAR B", winter);
    expect(writeOrder(one, "FRANCE", "B:MAR", "F MAR B", winter).FRANCE).toEqual({ "B:MAR": "F MAR B" });
  });

  it("caps disbands at what is owed", () => {
    const owed = { kind: "A" as const, allowance: -2 };
    let book = writeOrder({}, "AUSTRIA", "D:VIE", "A VIE D", owed);
    book = writeOrder(book, "AUSTRIA", "D:BUD", "A BUD D", owed);
    expect(writeOrder(book, "AUSTRIA", "D:TRI", "F TRI D", owed)).toBe(book);
  });

  it("writes nothing for a power that is owed nothing", () => {
    expect(writeOrder({}, "ITALY", "B:ROM", "A ROM B", { kind: "A", allowance: 0 })).toEqual({});
  });

  it("does not cap movement or retreat orders", () => {
    const book = writeOrder({}, "FRANCE", "A PAR", "A PAR - BUR", { kind: "M", allowance: 0 });
    expect(book.FRANCE).toEqual({ "A PAR": "A PAR - BUR" });
  });
});

describe("waiveBuild", () => {
  it("keeps waives apart after an earlier order is removed", () => {
    let book = waiveBuild({}, "RUSSIA", 3);
    book = waiveBuild(book, "RUSSIA", 3);
    expect(Object.keys(book.RUSSIA!)).toEqual(["WAIVE:0", "WAIVE:1"]);
    // Before the fix the key was `WAIVE:${count}`: with one order left the next waive was
    // written to WAIVE:1 again and silently replaced the one already there.
    book = eraseOrder(book, "RUSSIA", "WAIVE:0");
    book = waiveBuild(book, "RUSSIA", 3);
    expect(Object.values(book.RUSSIA!)).toEqual(["WAIVE", "WAIVE"]);
    expect(Object.keys(book.RUSSIA!).sort()).toEqual(["WAIVE:0", "WAIVE:1"]);
  });

  it("counts builds already written and never exceeds the allowance", () => {
    const built = writeOrder({}, "RUSSIA", "B:MOS", "A MOS B", { kind: "A", allowance: 2 });
    const one = waiveBuild(built, "RUSSIA", 2);
    expect(Object.keys(one.RUSSIA!)).toHaveLength(2);
    expect(waiveBuild(one, "RUSSIA", 2)).toBe(one);
  });

  it("does nothing for a power that must disband or is owed nothing", () => {
    expect(waiveBuild({}, "AUSTRIA", -1)).toEqual({});
    expect(waiveBuild({}, "ITALY", 0)).toEqual({});
  });
});

describe("toBook", () => {
  it("keys movement orders by unit and adjustments by province, with distinct waives", () => {
    expect(toBook({ FRANCE: ["A PAR - BUR", "F BRE H"] }, "M")).toEqual({
      FRANCE: { "A PAR": "A PAR - BUR", "F BRE": "F BRE H" },
    });
    expect(toBook({ RUSSIA: ["A MOS B", "WAIVE", "WAIVE"], AUSTRIA: ["F TRI D"] }, "A")).toEqual({
      RUSSIA: { "B:MOS": "A MOS B", "WAIVE:0": "WAIVE", "WAIVE:1": "WAIVE" },
      AUSTRIA: { "D:TRI": "F TRI D" },
    });
  });
});

describe("keepLegal", () => {
  it("drops orders the current phase does not allow", () => {
    const legal = { FRANCE: { "A PAR": ["A PAR H", "A PAR - BUR"] } };
    expect(
      keepLegal({ FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR - SPA" }, GERMANY: { "A MUN": "A MUN H" } }, legal, "M"),
    ).toEqual({ FRANCE: { "A PAR": "A PAR - BUR" } });
    expect(
      keepLegal({ FRANCE: { "B:PAR": "A PAR B", "B:MAR": "F MAR B", "WAIVE:0": "WAIVE" } }, { FRANCE: { "": ["A PAR B"] } }, "A"),
    ).toEqual({ FRANCE: { "B:PAR": "A PAR B", "WAIVE:0": "WAIVE" } });
  });
});
