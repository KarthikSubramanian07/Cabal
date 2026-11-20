/**
 * The prompt sections added for issue #11, starting with candidate framing for crowded units.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PERSONAS,
  validateOrders,
} from "./player.js";
import { CROWDED_UNIT, type PromptInput, legalMenu, systemPrompt } from "./prompt.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

/** A crowded midgame: a French fleet in the Mid-Atlantic with neighbours on every side. */
function crowded(): PromptInput {
  const game = new Game();
  const state = game.state();
  game.free();
  const units = {
    ...state.units,
    FRANCE: ["F MAO", "A GAS", "A SPA", "F BRE", "A PAR"],
    ENGLAND: ["F ENG", "F IRI", "A WAL", "F NAO"],
    ITALY: ["F WES", "A PIE", "F TYS"],
  };
  const g = Game.fromState({ ...state, units });
  const input: PromptInput = {
    power: "FRANCE",
    persona: PERSONAS["FRANCE"]!,
    phase: g.phase(),
    state: g.state(),
    map: mapInfo(),
    legal: g.legal("FRANCE"),
    press: [],
    myPledges: [],
    trust: {},
    diary: [],
    relationships: [],
  };
  g.free();
  return input;
}

describe("candidate framing", () => {
  it("frames a crowded unit as moves first, then supports grouped by whose unit they help", () => {
    const input = crowded();
    const mao = input.legal.by_unit["F MAO"]!;
    expect(mao.length).toBeGreaterThan(CROWDED_UNIT);
    const menu = legalMenu(input);
    const block = menu.split("\n").slice(menu.split("\n").findIndex((l) => l.startsWith("F MAO:")));
    expect(block[0]).toMatch(/^F MAO: \d+ orders\. Moves reach .*ENG \(ENGLAND unit\)/);
    expect(block[0]).toMatch(/SPA\/NC \(your unit, neutral centre\)|SPA\/SC \(your unit, neutral centre\)/);
    expect(block[1]).toBe("  F MAO H");
    const own = block.indexOf("  [supports for your own units]");
    const others = block.indexOf("  [supports for other powers' units]");
    expect(own).toBeGreaterThan(1);
    expect(others).toBeGreaterThan(own);
    expect(block.slice(own + 1, others).every((l) => / S [AF] (GAS|SPA|BRE|PAR)/.test(l))).toBe(true);
  });

  it("keeps every legal order on the menu, so nothing the model may choose is hidden", () => {
    const input = crowded();
    const menu = legalMenu(input);
    for (const orders of Object.values(input.legal.by_unit)) for (const o of orders) expect(menu).toContain(`  ${o}\n`.trimEnd());
  });

  it("leaves short menus as they were", () => {
    const game = new Game();
    const menu = legalMenu({ ...crowded(), state: game.state(), legal: game.legal("FRANCE") });
    game.free();
    expect(menu).not.toContain("[supports");
    expect(menu).not.toContain("orders. Moves reach");
    expect(menu.split("\n")).toContain("F BRE:");
  });

  it("frames the busiest unit of a real game, whatever its kind", () => {
    // Spring 1902 after a quiet opening: the English fleet in the North Sea has a long menu.
    const game = new Game();
    game.process({ orders: { ENGLAND: ["F LON - NTH", "F EDI - NWG", "A LVP - YOR"], GERMANY: ["F KIE - DEN", "A BER - KIE", "A MUN - RUH"], FRANCE: ["A PAR - BUR", "F BRE - MAO", "A MAR - SPA"] } });
    while (game.phase() !== "S1902M") game.process({ orders: {} });
    const input: PromptInput = { ...crowded(), power: "ENGLAND", phase: game.phase(), state: game.state(), legal: game.legal("ENGLAND") };
    game.free();
    const [unit, orders] = Object.entries(input.legal.by_unit).sort((a, b) => b[1].length - a[1].length)[0]!;
    expect(orders.length).toBeGreaterThan(CROWDED_UNIT);
    const menu = legalMenu(input);
    const head = menu.split("\n").find((l) => l.startsWith(`${unit}: ${orders.length} orders. Moves reach `));
    expect(head).toMatch(/\((empty|your unit|[A-Z]+ unit)(, (neutral centre|your centre|[A-Z]+ centre))?\)/);
    // Every legal order is still on the menu, exactly once, each on its own indented line.
    for (const o of orders) expect(menu.split("\n").filter((l) => l === `  ${o}`)).toHaveLength(1);
  });

  it("sits beside the system prompt's pledge strategy, which stays", () => {
    const text = systemPrompt(mapInfo());
    expect(text).toContain("# Pledges and the ledger");
    expect(text).toMatch(/Pledge little and keep it/);
  });

  it("accepts an order the model copied with the framing's note on it", () => {
    const legal = { "F MAO": ["F MAO H", "F MAO - ENG"] };
    const v = validateOrders({ orders: ["F MAO - ENG (ENGLAND unit)"] }, legal);
    expect(v.orders).toEqual(["F MAO - ENG"]);
    expect(v.dropped).toEqual([]);
  });
});
