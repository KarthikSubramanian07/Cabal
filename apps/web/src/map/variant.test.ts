import { describe, expect, it } from "vitest";
import duel from "../../../../crates/cabal-engine/data/maps/duel.json";
import standard from "../../../../crates/cabal-engine/data/maps/standard.json";
import geometry from "./board.json";
import { type BoardGeometry, BoardMismatch, type VariantDocument, composeBoard } from "./variant.js";

const drawn = geometry as unknown as BoardGeometry;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };
/** A copy of the standard map document to break in one place. */
const variant = (): Mutable<VariantDocument> => structuredClone(standard) as Mutable<VariantDocument>;
const problems = (v: VariantDocument, g: BoardGeometry = drawn) => {
  try {
    composeBoard(v, g);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(BoardMismatch);
    return [...(err as BoardMismatch).problems];
  }
};

describe("composeBoard", () => {
  const board = composeBoard(standard, drawn);
  const provinces = Object.entries(board.provinces);

  it("takes every province, and only those, from the variant", () => {
    expect(provinces).toHaveLength(standard.provinces.length);
    expect(Object.keys(board.provinces)).toEqual(standard.provinces.map((p) => p.name.toUpperCase()).sort());
  });

  it("names and kinds each province as the variant does", () => {
    expect(board.provinces.STP?.name).toBe("St Petersburg");
    expect(board.provinces.NTH?.kind).toBe("sea");
    expect(board.provinces.BUR?.kind).toBe("land");
    expect(board.provinces.BRE?.kind).toBe("coast");
    // No border reaches Switzerland, so no unit can enter it.
    expect(board.provinces.SWI?.kind).toBe("impassable");
    const count = (kind: string) => provinces.filter(([, p]) => p.kind === kind).length;
    expect([count("land"), count("coast"), count("sea"), count("impassable")]).toEqual([17, 39, 19, 1]);
  });

  it("marks the variant's supply centres and named coasts, where the geometry puts them", () => {
    const centres = standard.provinces.filter((p) => p.supply_center).map((p) => p.name.toUpperCase()).sort();
    expect(provinces.filter(([, p]) => p.sc).map(([code]) => code)).toEqual(centres);
    expect(centres).toHaveLength(34);
    expect(board.provinces.PAR?.sc).toEqual(drawn.provinces.PAR?.sc);
    expect(provinces.filter(([, p]) => p.coasts).map(([code, p]) => `${code} ${Object.keys(p.coasts!).join(" ")}`)).toEqual([
      "BUL EC SC",
      "SPA NC SC",
      "STP NC SC",
    ]);
  });

  it("keeps the geometry's shapes as they are", () => {
    expect(board.width).toBe(drawn.width);
    expect(board.coast).toBe(drawn.coast);
    expect(board.provinces.PAR?.d).toBe(drawn.provinces.PAR?.d);
    expect(board.provinces.PAR?.unit).toEqual(drawn.provinces.PAR?.unit);
  });

  it("follows the variant: a centre the variant takes away is not drawn, and one it adds must be", () => {
    const v = variant();
    v.provinces.find((p) => p.name === "par")!.supply_center = null;
    expect(problems(v)).toEqual(["a supply centre marker for PAR, which has no centre"]);
    const w = variant();
    w.provinces.find((p) => p.name === "bur")!.supply_center = "neutral";
    expect(problems(w)).toEqual(["no supply centre marker for BUR"]);
  });

  it("refuses geometry that misses a province, or a coast, the variant has", () => {
    const v = variant();
    v.provinces.push({ name: "atl", full_name: "Atlantis", supply_center: null });
    v.regions.push({ province: "atl", coast: null, terrain: "sea" });
    v.borders.push({ from: "atl", to: "nao" });
    expect(problems(v)).toEqual(["no outline for ATL"]);
    const w = variant();
    w.regions.push({ province: "por", coast: "n", terrain: "sea" });
    expect(problems(w)).toEqual(["no position for the fleet on POR/NC"]);
  });

  it("refuses a variant it has no geometry for, saying what is missing", () => {
    const found = problems(duel as VariantDocument);
    expect(found[0]).toBe("it draws the standard map");
    expect(found).toContain("no outline for RED");
    expect(found).toContain("an outline for PAR, which the map does not have");
    expect(() => composeBoard(duel as VariantDocument, drawn)).toThrow(/does not fit the duel map/);
  });
});
