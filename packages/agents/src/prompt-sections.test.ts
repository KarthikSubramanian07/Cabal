/**
 * The prompt sections added for issue #11: candidate framing for crowded units, the yearly plan
 * and the yearly diary consolidation. All with scripted brains: no model is called.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, mapInfo, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Brain,
  type BrainReply,
  type BrainRequest,
  type Decision,
  MEMORY_LIMITS,
  PERSONAS,
  Player,
  consolidate,
  staleYears,
  validateOrders,
  yearOf,
} from "./player.js";
import { COVERING_NOTE, CROWDED_UNIT, type PromptInput, legalMenu, systemPrompt, userPrompt } from "./prompt.js";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../engine/pkg/cabal_engine_bg.wasm", import.meta.url));
  await ready(readFileSync(wasm));
});

/** A brain that holds everything and fills in whatever the script says, recording each prompt. */
function scripted(extra: (r: BrainRequest) => Partial<Decision> = () => ({})) {
  const prompts: string[] = [];
  const brain: Brain = {
    async decide(request: BrainRequest): Promise<BrainReply> {
      prompts.push(request.prompt);
      const holds = [...request.prompt.matchAll(/^ {2}([AF] [A-Z]{3}(?:\/[A-Z]{2})? H)$/gm)].map((m) => m[1]!);
      return {
        decision: { reasoning: "", orders: holds, messages: [], pledge: null, relationships: [], diary: `${/Phase (\S+)\./.exec(request.prompt)![1]} note`, ...extra(request) },
        usage: null,
        model: null,
      };
    },
  };
  return { brain, prompts };
}

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

describe("the yearly plan", () => {
  it("is asked for at the first movement decision of a year and shown for the rest of it", async () => {
    const { brain, prompts } = scripted((r) => (r.prompt.includes("Also fill `plan`") ? { plan: "Take Iberia with German quiet." } : {}));
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const game = new Game();
    const base = { state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    game.free();
    await player.play({ ...base, phase: "S1901M", step: "negotiate" });
    await player.play({ ...base, phase: "S1901M" });
    await player.play({ ...base, phase: "F1901M" });
    expect(prompts[0]).toContain("This is your first decision of 1901. Also fill `plan`");
    expect(prompts[0]).toContain("# Your plan for this year\nnone yet: write it now");
    for (const later of prompts.slice(1)) {
      expect(later).not.toContain("Also fill `plan`");
      expect(later).toContain("# Your plan for this year\nTake Iberia with German quiet.");
      // The plan is its own section, not a diary line.
      expect(later.split("# Your diary\n")[1]!.split("\n\n")[0]).not.toContain("plan:");
    }
  });

  it("asks again next turn when the model left the plan out", async () => {
    const { brain, prompts } = scripted();
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const game = new Game();
    const base = { state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    game.free();
    await player.play({ ...base, phase: "S1901M" });
    await player.play({ ...base, phase: "F1901M" });
    // Asked once; with no plan written it asks again, which costs nothing more than the one field.
    expect(prompts[1]).toContain("Also fill `plan`");
  });

  it("is kept as plain diary text, so a server that stores only diary and relationships keeps it", async () => {
    const { brain, prompts } = scripted((r) => (r.prompt.includes("Also fill `plan`") ? { plan: "Fleets north." } : {}));
    const game = new Game();
    const base = { state: game.state(), map: mapInfo(), legal: game.legal("ENGLAND"), press: [], myPledges: [], trust: {} };
    game.free();
    const first = new Player("ENGLAND", PERSONAS["ENGLAND"]!, brain);
    await first.play({ ...base, phase: "S1901M" });
    const stored = JSON.parse(JSON.stringify(first.memory()));
    const second = new Player("ENGLAND", PERSONAS["ENGLAND"]!, brain, stored);
    await second.play({ ...base, phase: "F1901M" });
    expect(prompts.at(-1)).toContain("# Your plan for this year\nFleets north.");
    expect(prompts.at(-1)).not.toContain("Also fill `plan`");
  });
});

describe("diary consolidation", () => {
  it("folds each finished year into one line, in the model's words when it was asked", async () => {
    const { brain, prompts } = scripted((r) =>
      r.prompt.includes("Also fill `yearSummary`") ? { plan: "Hold.", yearSummary: "Germany helped; England lied about the Channel." } : { plan: "Hold." },
    );
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const game = new Game();
    const base = { state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    game.free();
    for (const phase of ["S1901M", "F1901M", "W1901A"]) await player.play({ ...base, phase });
    expect(player.diary.filter((e) => e.startsWith("S1901M") || e.startsWith("F1901M") || e.startsWith("W1901A"))).toHaveLength(3);
    await player.play({ ...base, phase: "S1902M" });
    expect(prompts[3]).toContain("Also fill `yearSummary`: 1901 as your diary tells it");
    expect(player.diary).toEqual(["1901 in brief: Germany helped; England lied about the Channel.", "1902 plan: Hold.", "S1902M: S1902M note"]);
  });

  it("stays bounded over ten years of play", async () => {
    const { brain } = scripted((r) => ({ plan: "A plan.", ...(r.prompt.includes("yearSummary") ? { yearSummary: "x".repeat(1000) } : {}) }));
    const player = new Player("FRANCE", PERSONAS["FRANCE"]!, brain);
    const game = new Game();
    const base = { state: game.state(), map: mapInfo(), legal: game.legal("FRANCE"), press: [], myPledges: [], trust: {} };
    game.free();
    for (let year = 1901; year <= 1910; year++) {
      for (const phase of [`S${year}M`, `S${year}R`, `F${year}M`, `F${year}R`, `W${year}A`]) {
        await player.play({ ...base, phase, step: "negotiate" });
        await player.play({ ...base, phase });
      }
    }
    const briefs = player.diary.filter((e) => / in brief: /.test(e));
    expect(briefs.map((e) => e.slice(0, 4))).toEqual(["1901", "1902", "1903", "1904", "1905", "1906", "1907", "1908", "1909"]);
    expect(player.diary.length).toBeLessThanOrEqual(MEMORY_LIMITS.diaryEntries);
    expect(player.diary.every((e) => e.length <= MEMORY_LIMITS.diaryChars)).toBe(true);
    // Ten years, two steps per phase: 100 entries without consolidation, about 20 with it.
    expect(player.diary.length).toBeLessThan(25);
  });

  it("folds mechanically when nobody wrote a summary, and leaves a stored brief alone", () => {
    const diary = ["S1901M: Opened west.", "F1901M (talks): Asked for Belgium.", "1901 plan: Iberia.", "S1902M: Moved."];
    expect(staleYears(diary, 1902)).toEqual([1901]);
    const folded = consolidate(diary, [1901], null);
    expect(folded).toEqual(["1901 in brief: Opened west. / Asked for Belgium. / Iberia.", "S1902M: Moved."]);
    expect(staleYears(folded, 1902)).toEqual([]);
    expect(staleYears(folded, 1903)).toEqual([1902]);
  });

  it("reads years from phase names only", () => {
    expect(yearOf("S1901M")).toBe(1901);
    expect(yearOf("W1910A")).toBe(1910);
    expect(yearOf("COMPLETED")).toBeNull();
  });

  it("keeps the new sections out of turns that do not need them", () => {
    const text = userPrompt({ ...crowded(), phase: "F1901R" });
    expect(text).not.toContain("# Your plan for this year");
    expect(text).not.toContain("Also fill");
  });
});

describe("covering an absent player's seat", () => {
  it("tells the model to give orders only, last, after the task's invitation to send press", () => {
    const text = userPrompt({ ...crowded(), covering: true });
    expect(text).toContain(COVERING_NOTE);
    expect(text.indexOf(COVERING_NOTE)).toBeGreaterThan(text.indexOf("You may send a last"));
    expect(userPrompt(crowded())).not.toContain("You are covering this seat");
  });
});
