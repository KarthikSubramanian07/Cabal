import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type Brain, type Decision, PERSONAS, Player, validateOrders } from "./player.js";
import { userPrompt } from "./prompt.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

class ScriptedBrain implements Brain {
  prompts: string[] = [];
  constructor(private decision: Decision) {}
  async decide(_system: string, prompt: string): Promise<Decision> {
    this.prompts.push(prompt);
    return this.decision;
  }
}

describe("validateOrders", () => {
  it("keeps menu orders, repairs arrows, drops off-menu and duplicate orders", () => {
    const legal = { "A PAR": ["A PAR H", "A PAR - BUR", "A PAR - PIC"], "F BRE": ["F BRE H", "F BRE - MAO"] };
    const v = validateOrders(
      {
        reasoning: "",
        orders: ["a par -> bur", "F BRE - MAO", "A PAR - PIC", "A MAR - SPA"],
        messages: [],
        pledge: null,
        relationships: [],
        diary: "",
      },
      legal,
    );
    expect(v.orders).toEqual(["A PAR - BUR", "F BRE - MAO"]);
    expect(v.dropped.map((d) => d.reason)).toEqual(["second order for A PAR", "not on the legal menu"]);
  });
});

describe("Player", () => {
  it("builds a narrative prompt and returns validated orders", async () => {
    const game = new Game();
    const legal = game.legal("FRANCE");
    const brain = new ScriptedBrain({
      reasoning: "Take Iberia.",
      orders: ["A MAR - SPA", "F BRE - MAO", "A PAR - BUR"],
      messages: [{ to: "GERMANY", body: "Burgundy is a demilitarised zone, yes?" }],
      pledge: { to: "GERMANY", orders: ["A PAR - BUR"], sealed: false },
      relationships: [{ power: "GERMANY", stance: 1, note: "useful for now" }],
      diary: "Opened west.",
    });
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const { validated } = await player.play({
      phase: "S1901M",
      state: game.state(),
      map: mapInfo(),
      legal,
      press: [],
      myPledges: [],
      trust: {},
    });
    expect(validated.orders).toEqual(["A MAR - SPA", "F BRE - MAO", "A PAR - BUR"]);
    expect(player.diary).toEqual(["S1901M: Opened west."]);
    expect(player.relationships.get("GERMANY")?.stance).toBe(1);
    const prompt = brain.prompts[0]!;
    expect(prompt).toContain("You are FRANCE");
    expect(prompt).toContain("A PAR - BUR");
    expect(prompt).toContain("Unowned centres");
  });

  it("falls back to holds when the brain fails", async () => {
    const brain: Brain = {
      decide: async () => {
        throw new Error("boom");
      },
    };
    const game = new Game();
    const player = new Player("ITALY", PERSONAS["ITALY"]!, brain);
    const { validated, decision } = await player.play({
      phase: "S1901M",
      state: game.state(),
      map: mapInfo(),
      legal: game.legal("ITALY"),
      press: [],
      myPledges: [],
      trust: {},
    });
    expect(validated.orders).toEqual([]);
    expect(decision.reasoning).toContain("boom");
  });

  it("renders the prompt sections", () => {
    const game = new Game();
    const text = userPrompt({
      power: "TURKEY",
      persona: "x",
      phase: "S1901M",
      state: game.state(),
      map: mapInfo(),
      legal: game.legal("TURKEY"),
      press: [{ from: "RUSSIA", to: "TURKEY", body: "Black Sea stays empty?", pledge: ["F SEV H"] }],
      diary: ["S1900: born"],
      relationships: [{ power: "RUSSIA", stance: -1, note: "wants Armenia" }],
      myPledges: [["F ANK H"]],
      trust: { RUSSIA: { kept: 3, broken: 1 } },
    });
    expect(text).toContain("RUSSIA -> TURKEY: Black Sea stays empty? [pledge: F SEV H]");
    expect(text).toContain("RUSSIA: kept 3, broken 1");
    expect(text).toContain("F ANK H");
  });
});
