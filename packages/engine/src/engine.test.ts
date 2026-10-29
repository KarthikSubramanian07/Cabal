import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Game,
  POWERS,
  canonicalOrder,
  mapInfo,
  pledgeCommit,
  pledgeOpens,
  pledgeReceipt,
  preview,
  randomNonce,
  ready,
  version,
} from "./index.js";

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL("../pkg/cabal_engine_bg.wasm", import.meta.url),
  );
  await ready(readFileSync(wasmPath));
});

describe("engine module", () => {
  it("loads and reports a version", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("describes the standard map", () => {
    const map = mapInfo();
    expect(map.name).toBe("standard");
    expect(map.powers).toHaveLength(7);
    expect(map.provinces.filter((p) => p.supply_center != null)).toHaveLength(
      34,
    );
    const stp = map.provinces.find((p) => p.id === "STP");
    expect(stp?.coasts).toEqual(["NC", "SC"]);
    expect(stp?.fleet_adjacent["SC"]).toContain("BOT");
  });
});

describe("Game", () => {
  it("plays Spring 1901 and explains every order", () => {
    const game = new Game();
    expect(game.phase()).toBe("S1901M");
    const state = game.state();
    expect(state.units["FRANCE"]).toEqual(["F BRE", "A MAR", "A PAR"]);
    const legal = game.legal("FRANCE");
    expect(Object.keys(legal.by_unit).sort()).toEqual(["A MAR", "A PAR", "F BRE"]);
    expect(legal.by_unit["A PAR"]).toContain("A PAR - BUR");
    const outcome = game.process({
      orders: {
        FRANCE: ["A PAR - BUR", "A MAR - SPA", "F BRE - MAO"],
        GERMANY: ["A MUN - BUR"],
      },
    });
    expect(outcome.phase).toBe("S1901M");
    const par = outcome.results.find((r) => r.unit === "A PAR");
    expect(par?.ok).toBe(false);
    expect(par?.code).toBe("bounce");
    expect(par?.reason).toContain("MUN");
    expect(outcome.next.name).toBe("F1901M");
    expect(outcome.next.units["FRANCE"]).toContain("A SPA");
    expect(game.historyLength()).toBe(1);
  });

  it("round trips through the MILA saved game format", () => {
    const game = new Game();
    game.process({ orders: { ENGLAND: ["F LON - NTH"] } });
    const json = game.toSaved("t1");
    const parsed = JSON.parse(json) as { phases: { name: string }[] };
    expect(parsed.phases.map((p) => p.name)).toEqual(["S1901M", "F1901M"]);
    const replayed = Game.fromSaved(json);
    expect(replayed.phase()).toBe("F1901M");
  });

  it("previews without mutating", () => {
    const game = new Game();
    const out = preview(game.state(), {
      orders: { RUSSIA: ["F SEV - BLA"], TURKEY: ["F ANK - BLA"] },
    });
    expect(out.results.find((r) => r.unit === "F SEV")?.code).toBe("bounce");
    expect(game.phase()).toBe("S1901M");
  });

  it("normalises against actual units before processing and is idempotent", () => {
    const game = new Game();
    const input = { orders: { FRANCE: ["F PAR/NC - BUR/SC", "MAR - SPA"] } };
    const canonical = game.normaliseOrders(input);
    expect(canonical.orders.FRANCE).toEqual(["A PAR - BUR", "A MAR - SPA"]);
    expect(game.normaliseOrders(canonical)).toEqual(canonical);
    const prefixed = game.normaliseOrders({ orders: { FRANCE: ["FRANCE: A PAR - BUR"] } });
    expect(prefixed.orders.FRANCE).toEqual(["FRA: A PAR - BUR"]);
    expect(game.normaliseOrders(prefixed)).toEqual(prefixed);
    const outcome = game.process(canonical);
    expect(outcome.next.units.FRANCE).toContain("A BUR");
    expect(outcome.next.units.FRANCE).toContain("A SPA");
  });

  it("retains illegal and duplicate orders for adjudication diagnostics", () => {
    const game = new Game();
    const input = { orders: { FRANCE: ["A PAR - PAR", "A MAR H", "A MAR - SPA"] } };
    const normalised = game.normaliseOrders(input);
    expect(normalised.orders.FRANCE).toHaveLength(3);
    const outcome = game.process(normalised);
    expect(outcome.results.find((r) => r.unit === "A PAR")?.code).toBe("illegal");
    expect(outcome.results.find((r) => r.unit === "A MAR")?.code).toBe("illegal");
  });

  it("exposes deterministic explanation edges and standalone DOT to both hosts", () => {
    const game = new Game();
    const input = { orders: { FRANCE: ["A PAR - BUR", "A MAR S A PAR - BUR"], GERMANY: ["A MUN - BUR"] } };
    const first = preview(game.state(), input);
    const second = preview(game.state(), { orders: { GERMANY: input.orders.GERMANY, FRANCE: [...input.orders.FRANCE].reverse() } });
    expect(first.dependencies.length).toBeGreaterThan(0);
    expect(second.dependencies).toEqual(first.dependencies);
    expect(second.dependency_dot).toBe(first.dependency_dot);
    expect(first.dependency_dot).toMatch(/^digraph movement \{/);
    const par = first.results.findIndex((r) => r.unit === "A PAR");
    const mar = first.results.findIndex((r) => r.unit === "A MAR");
    expect(first.dependencies).toContainEqual([par, mar]);
    expect(JSON.parse(JSON.stringify(first)).dependencies).toEqual(first.dependencies);
  });

  it("never lets a power prefix order another power's units", () => {
    const game = new Game();
    const spoofed = { orders: { GERMANY: ["FRA: A PAR - PIC"] } };
    expect(() => game.normaliseOrders(spoofed)).toThrow(/submitted for Germany/);
    expect(() => game.process(spoofed)).toThrow(/submitted for Germany/);
    expect(() => canonicalOrder("FRA: A PAR - PIC", "M", "GERMANY")).toThrow(/submitted for Germany/);
    expect(canonicalOrder("GER: A MUN - BUR", "M", "GERMANY")).toBe("A MUN - BUR");
  });

  it("rejects orders that do not parse", () => {
    const game = new Game();
    expect(() =>
      game.process({ orders: { FRANCE: ["A PAR - NOWHERE"] } }),
    ).toThrow(/NOWHERE/);
  });
});

describe("orders and seals", () => {
  it("canonicalises order text", () => {
    expect(canonicalOrder("a par -> bur", "M", "FRANCE")).toBe("A PAR - BUR");
    expect(canonicalOrder("F NTH convoys A LON - BRE", "M", "ENGLAND")).toBe(
      "F NTH C A LON - BRE",
    );
  });

  it("seals open only with the same orders and nonce", () => {
    const nonce = randomNonce();
    const seal = pledgeCommit(["A MUN S F KIE - DEN"], nonce);
    expect(pledgeOpens(seal, ["a mun s f kie - den"], nonce)).toBe(true);
    expect(pledgeOpens(seal, ["A MUN H"], nonce)).toBe(false);
  });

  it("issues receipts", () => {
    expect(
      pledgeReceipt(["A MUN S F KIE - DEN"], ["A MUN S F KIE - DEN", "F KIE - DEN"]),
    ).toBe("kept");
    expect(pledgeReceipt(["A MUN S F KIE - DEN"], ["A MUN - BUR"])).toBe(
      "broken",
    );
    expect(pledgeReceipt(["A MUN H"], [])).toBe("void");
  });

  it("knows the seven powers", () => {
    expect(POWERS).toHaveLength(7);
  });
});
