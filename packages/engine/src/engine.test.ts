import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Game,
  POWERS,
  botOrders,
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
    const input = { orders: { FRANCE: ["A PAR - BUR", "A MAR S A PAR - BUR"], GERMANY: ["A MUN - BUR"] } };
    const reversed = { orders: { GERMANY: input.orders.GERMANY, FRANCE: [...input.orders.FRANCE].reverse() } };
    const play = (orders: typeof input) => {
      const game = new Game();
      const outcome = game.process(orders);
      return { game, outcome, explanation: game.explain(0) };
    };
    const first = play(input);
    const second = play(reversed);
    expect(first.outcome).not.toHaveProperty("dependencies");
    expect(first.explanation.edges.length).toBeGreaterThan(0);
    expect(second.explanation.edges).toEqual(first.explanation.edges);
    expect(second.explanation.dot).toBe(first.explanation.dot);
    expect(first.explanation.dot).toMatch(/^digraph movement \{/);
    const par = first.outcome.results.findIndex((r) => r.unit === "A PAR");
    const mar = first.outcome.results.findIndex((r) => r.unit === "A MAR");
    expect(first.explanation.edges).toContainEqual([par, mar]);
    expect(JSON.parse(JSON.stringify(first.explanation)).edges).toEqual(first.explanation.edges);
    expect(() => first.game.explain(1)).toThrow(/no such phase/);
  });

  it("explains movement phases only", () => {
    const state = new Game().state();
    state.units = { FRANCE: ["A BUR"], GERMANY: ["A MUN", "A RUH"] };
    const game = Game.fromState(state);
    game.process({ orders: { GERMANY: ["A MUN - BUR", "A RUH S A MUN - BUR"] } });
    expect(game.phase()).toBe("S1901R");
    game.process({ orders: { FRANCE: ["A BUR - PAR"] } });
    expect(game.explain(0).edges.length).toBeGreaterThan(0);
    expect(() => game.explain(1)).toThrow(/not a movement phase/);
  });

  it("never lets a power prefix order another power's units", () => {
    const game = new Game();
    const spoofed = { orders: { GERMANY: ["FRA: A PAR - PIC"] } };
    // set aside with a reason instead of failing the phase
    expect(game.normaliseOrders(spoofed)).toEqual(spoofed);
    const outcome = game.process(spoofed);
    expect(outcome.rejected).toEqual([
      {
        power: "GERMANY",
        input: "FRA: A PAR - PIC",
        code: "wrong_power",
        reason: "The order names France but was submitted for Germany.",
      },
    ]);
    expect(outcome.next.units["FRANCE"]).toContain("A PAR");
    expect(() => canonicalOrder("FRA: A PAR - PIC", "M", "GERMANY")).toThrow(/submitted for Germany/);
    expect(canonicalOrder("GER: A MUN - BUR", "M", "GERMANY")).toBe("A MUN - BUR");
  });

  it("adjudicates the rest of a phase when one order does not parse", () => {
    const game = new Game();
    const outcome = game.process({
      orders: { FRANCE: ["A PAR - NOWHERE", "A MAR - SPA"], GERMANY: ["A MUN - BUR"] },
    });
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]).toMatchObject({ power: "FRANCE", input: "A PAR - NOWHERE", code: "unparseable" });
    expect(outcome.rejected[0]?.reason).toContain("NOWHERE");
    expect(outcome.next.units["FRANCE"]).toContain("A SPA");
    expect(outcome.next.units["GERMANY"]).toContain("A BUR");
    expect(outcome.results.find((r) => r.unit === "A PAR")?.code).toBe("ok");
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

describe("botOrders", () => {
  const playAll = (game: Game, seed: string, level: "easy" | "standard" | "hard") => {
    const orders: Record<string, string[]> = {};
    for (const power of POWERS) {
      orders[power] = botOrders(game, power, { seed, level }).orders;
    }
    return orders;
  };

  it("returns one legal order per unit with an intent summary", () => {
    const game = new Game();
    const decision = botOrders(game, "FRANCE", { seed: "g1" });
    expect(decision.power).toBe("FRANCE");
    expect(decision.phase).toBe("S1901M");
    expect(decision.level).toBe("standard");
    expect(decision.orders).toHaveLength(3);
    const legal = game.legal("FRANCE");
    for (const order of decision.orders) {
      const unit = order.split(" ").slice(0, 2).join(" ");
      expect(legal.by_unit[unit]).toContain(order);
    }
    expect(decision.intent.candidates).toBeGreaterThan(0);
    expect(decision.intent.adjudications).toBeGreaterThan(0);
    expect(Array.isArray(decision.intent.targets)).toBe(true);
    expect(Array.isArray(decision.intent.fears)).toBe(true);
  });

  it("is deterministic for a seed and accepts numeric seeds", () => {
    const game = new Game();
    for (const level of ["easy", "standard", "hard"] as const) {
      const a = botOrders(game, "RUSSIA", { seed: "same", level });
      const b = botOrders(game, "RUSSIA", { seed: "same", level });
      expect(b).toEqual(a);
    }
    expect(botOrders(game, "ITALY", { seed: 7 })).toEqual(
      botOrders(game, "ITALY", { seed: "7" }),
    );
  });

  it("plays whole games for all seven powers without one illegal order", () => {
    for (const level of ["easy", "standard"] as const) {
      const game = new Game();
      const kinds = new Set<string>();
      let orders = 0;
      while (game.status() === "active" && !game.phase().startsWith("S1907")) {
        kinds.add(game.phase().slice(-1));
        const outcome = game.process({ orders: playAll(game, `ts-${level}`, level) });
        orders += outcome.results.length;
        for (const result of outcome.results) {
          expect(result.code, `${outcome.phase} ${result.order}`).not.toBe("illegal");
        }
      }
      expect(orders).toBeGreaterThan(300);
      expect([...kinds].sort()).toEqual(["A", "M", "R"]);
    }
  }, 120_000);

  it("fills builds to the allowance and retreats dislodged units", () => {
    const state = new Game().state();
    state.name = "W1901A";
    state.units = { FRANCE: ["A BEL", "A SPA", "F POR"] };
    state.centers = { FRANCE: ["PAR", "BRE", "MAR", "BEL", "SPA", "POR"] };
    const winter = Game.fromState(state);
    const builds = botOrders(winter, "FRANCE", { seed: 1, level: "hard" });
    expect(builds.orders).toHaveLength(3);
    expect(builds.orders.every((o) => o.endsWith(" B"))).toBe(true);
    const done = winter.process({ orders: { FRANCE: builds.orders } });
    expect(done.results.every((r) => r.ok)).toBe(true);
    expect(done.next.units["FRANCE"]).toHaveLength(6);

    const board = new Game().state();
    board.units = { FRANCE: ["A BUR"], GERMANY: ["A MUN", "A RUH"] };
    const game = Game.fromState(board);
    game.process({ orders: { GERMANY: ["A MUN - BUR", "A RUH S A MUN - BUR"] } });
    expect(game.phase()).toBe("S1901R");
    const retreat = botOrders(game, "FRANCE", { seed: 1 });
    expect(retreat.orders).toHaveLength(1);
    expect(retreat.orders[0]).toMatch(/^A BUR R [A-Z]{3}$/);
    expect(retreat.orders[0]).not.toBe("A BUR R MUN");
    const after = game.process({ orders: { FRANCE: retreat.orders } });
    expect(after.results[0]?.ok).toBe(true);
  });

  // FNV-1a over the bytes of an ASCII string: the same hash as `cabal_bot::seed_from_str`.
  const fnv1a64 = (text: string): string => {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
      h ^= BigInt(text.charCodeAt(i));
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
  };

  it("decides exactly what the native build decides (golden transcript)", () => {
    // The native half is `bot_decisions_match_the_golden_transcript` in
    // crates/cabal-wasm/src/lib.rs. Both play the same games, write one line per
    // decision from the same fields, and compare with the same file, so the two
    // targets cannot drift apart unnoticed.
    const golden = readFileSync(
      fileURLToPath(
        new URL("../../../crates/cabal-wasm/tests/bot-golden.txt", import.meta.url),
      ),
      "utf8",
    );
    const rows = golden
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(" "));
    expect(rows.map((r) => r[1])).toEqual(["easy", "standard", "hard"]);
    for (const [seed, level, until, decisions, hash] of rows) {
      const game = new Game();
      let text = "";
      let count = 0;
      while (
        game.status() === "active" &&
        Number(game.phase().slice(1, 5)) < Number(until)
      ) {
        const orders: Record<string, string[]> = {};
        for (const power of POWERS) {
          const d = botOrders(game, power, {
            seed: seed ?? "",
            level: level as "easy" | "standard" | "hard",
          });
          orders[power] = d.orders;
          const i = d.intent;
          const supports = i.supports.map(
            (s) => `${s.unit}>${s.supports}>${s.into ?? "-"}>${s.power}`,
          );
          const fears = i.fears.map((f) => `${f.power}:${f.threat}`);
          text +=
            `${d.phase} ${d.power} ${d.level}: ${d.orders.join("; ")} | ` +
            `targets=${i.targets.join(",")} against=${i.against.join(",")} ` +
            `defends=${i.defends.join(",")} supports=${supports.join(",")} ` +
            `fears=${fears.join(",")} c=${i.candidates} a=${i.adjudications}\n`;
          count++;
        }
        game.process({ orders });
      }
      expect(`${level} ${count} ${fnv1a64(text)}`).toBe(
        `${level} ${decisions} ${hash}`,
      );
    }
  }, 300_000);

  it("stays inside the 30 ms budget at the default level, measured in CPU time", () => {
    const game = new Game();
    while (game.status() === "active" && !game.phase().startsWith("S1905")) {
      game.process({ orders: playAll(game, "timing", "standard") });
    }
    playAll(game, "warm-up", "standard");
    playAll(game, "warm-up", "hard");
    // CPU time, not wall-clock time: a decision is single threaded and pure, so
    // the processor time this process spends on it barely moves when the machine
    // is busy with other work, which is what made a wall-clock median useless as
    // a gate. The adjudication counts are exact and identical on every machine.
    const measure = (level: "standard" | "hard", rounds: number, cap: number) => {
      const ms: number[] = [];
      for (let round = 0; round < rounds; round++) {
        for (const power of POWERS) {
          const before = process.cpuUsage();
          const decision = botOrders(game, power, { seed: `timing-${round}`, level });
          const spent = process.cpuUsage(before);
          ms.push((spent.user + spent.system) / 1000);
          expect(decision.intent.adjudications).toBeLessThanOrEqual(cap);
        }
      }
      ms.sort((a, b) => a - b);
      const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? Infinity;
      const stats = { fastest: at(0), median: at(0.5), p90: at(0.9), slowest: at(1) };
      console.info(
        `botOrders in wasm, ${level} level, ${ms.length} decisions on a 1905 board, CPU time: ` +
          `fastest ${stats.fastest.toFixed(2)} ms, median ${stats.median.toFixed(2)} ms, ` +
          `90th percentile ${stats.p90.toFixed(2)} ms, slowest ${stats.slowest.toFixed(2)} ms`,
      );
      return stats;
    };
    const standard = measure("standard", 6, 200);
    // The promise is 30 ms a decision. The median must keep a twofold margin
    // and nine decisions in ten must keep the promise itself.
    expect(standard.median).toBeLessThan(15);
    expect(standard.p90).toBeLessThan(30);
    // Hard spends up to fifteen times the adjudications and makes no 30 ms
    // promise; it is measured and bounded so that a seat cannot stall a phase.
    const hard = measure("hard", 2, 3000);
    expect(hard.median).toBeLessThan(200);
  }, 300_000);

  it("rejects unknown powers, unknown levels and finished games", () => {
    const game = new Game();
    expect(() => botOrders(game, "ATLANTIS", { seed: 1 })).toThrow(/unknown power/);
    expect(() =>
      botOrders(game, "FRANCE", { seed: 1, level: "godlike" as never }),
    ).toThrow(/unknown bot level/);
    game.declareDraw();
    expect(() => botOrders(game, "FRANCE", { seed: 1 })).toThrow(/finished/);
  });
});
