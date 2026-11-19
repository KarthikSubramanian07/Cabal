#!/usr/bin/env node
// Timings of the built engine through the wasm boundary, as a host pays them.
//
//   node packages/engine/bench/wasm-bench.mjs [pkg dir] [--json] [--rounds N]
//
// Every figure is the fastest of many rounds: on a shared machine the minimum is
// the only statistic that measures the code rather than the neighbours. Calls
// that an older build does not have are reported as null, so the same script
// compares builds before and after an API was added.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const json = args.includes("--json");
const roundsAt = args.indexOf("--rounds");
const ROUNDS = roundsAt >= 0 ? Number(args[roundsAt + 1]) : 40;
const dir = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--rounds") ?? "packages/engine/pkg");

const bytes = readFileSync(resolve(dir, "cabal_engine_bg.wasm"));
const wasm = await import(pathToFileURL(resolve(dir, "cabal_engine.js")).href);

const now = () => performance.now();
const cold = {};
let t = now();
const module = new WebAssembly.Module(bytes);
cold.compile_ms = now() - t;
t = now();
await wasm.default({ module_or_path: module });
cold.instantiate_ms = now() - t;
t = now();
let game = new wasm.Game();
cold.first_game_ms = now() - t;
t = now();
game.process({ orders: {} });
cold.first_process_ms = now() - t;

const POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"];
const OPENING = {
  AUSTRIA: ["A VIE - TRI", "A BUD - SER", "F TRI - ALB"],
  ENGLAND: ["F LON - NTH", "F EDI - NWG", "A LVP - YOR"],
  FRANCE: ["A PAR - BUR", "A MAR - SPA", "F BRE - MAO"],
  GERMANY: ["A BER - KIE", "A MUN - RUH", "F KIE - DEN"],
  ITALY: ["A ROM - APU", "A VEN - TYR", "F NAP - ION"],
  RUSSIA: ["A MOS - UKR", "A WAR - GAL", "F SEV - BLA", "F STP/SC - BOT"],
  TURKEY: ["A CON - BUL", "A SMY - CON", "F ANK - BLA"],
};
// 34 units, 18 fleets at sea: the worst case for legal order enumeration
const MIDGAME = {
  ENGLAND: ["F NAO", "F NWG", "F NTH", "F IRI", "A NWY", "A LON"],
  FRANCE: ["F ENG", "F MAO", "F WES", "A BRE", "A SPA"],
  GERMANY: ["F HEL", "F SKA", "F BAL", "A DEN", "A KIE"],
  RUSSIA: ["F BOT", "F BLA", "A STP", "A SEV"],
  ITALY: ["F LYO", "F TYS", "F ION", "A NAP", "A TUN"],
  TURKEY: ["F AEG", "F EAS", "A SMY", "A BUL", "A GRE"],
  AUSTRIA: ["F ADR", "A TRI", "A ALB", "A SER"],
};

/** Fastest of ROUNDS rounds of `inner` calls each, in microseconds per call. */
function best(inner, fn) {
  let min = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const start = now();
    for (let i = 0; i < inner; i++) fn();
    min = Math.min(min, (now() - start) / inner);
  }
  return Math.round(min * 1000 * 10) / 10;
}
const has = (object, name) => typeof object[name] === "function";
const maybe = (ok, inner, fn) => (ok ? best(inner, fn) : null);

const opening = new wasm.Game();
const openingState = opening.state();
const midState = { ...openingState, units: MIDGAME };
const mid = wasm.Game.fromState(midState);
const france = OPENING.FRANCE;

// a deterministic 40-phase game for the save and restore paths
const long = new wasm.Game();
let seed = 7;
const pick = (list) => list[(seed = (seed * 1103515245 + 12345) >>> 0) % list.length];
while (long.historyLength() < 40 && long.status() === "active") {
  const orders = {};
  for (const p of POWERS) {
    const legal = long.legal(p);
    orders[p] = Object.entries(legal.by_unit)
      .filter(([unit]) => unit !== "")
      .map(([, list]) => pick(list));
  }
  long.process({ orders });
}
const saved = long.toSaved("bench");

const warm = {
  new_game_us: best(50, () => new wasm.Game()),
  preview_opening_us: best(20, () => wasm.preview(openingState, { orders: OPENING })),
  game_preview_opening_us: maybe(has(opening, "preview"), 20, () => opening.preview({ orders: OPENING })),
  explain_preview_opening_us: maybe(has(opening, "explainPreview"), 20, () => opening.explainPreview({ orders: OPENING })),
  validate_three_orders_us: maybe(has(opening, "validateOrders"), 50, () => opening.validateOrders("FRANCE", france)),
  legal_seven_powers_opening_us: best(10, () => {
    for (const p of POWERS) opening.legal(p);
  }),
  legal_seven_powers_midgame_us: best(2, () => {
    for (const p of POWERS) mid.legal(p);
  }),
  legal_all_midgame_us: maybe(has(mid, "legalAll"), 2, () => mid.legalAll()),
  legal_moves_midgame_us: maybe(has(mid, "legalMoves"), 2, () => mid.legalMoves()),
  legal_moves_one_power_midgame_us: maybe(has(mid, "legalMoves"), 5, () => mid.legalMoves("ENGLAND")),
  to_saved_40_phases_us: best(3, () => long.toSaved("bench")),
  resume_40_phases_us: maybe(has(wasm.Game, "resume"), 3, () => wasm.Game.resume(saved)),
  from_saved_40_phases_us: best(2, () => wasm.Game.fromSaved(saved)),
};

const result = {
  pkg: dir,
  build: has(wasm, "buildInfo") ? wasm.buildInfo() : { version: wasm.version() },
  wasm_bytes: bytes.length,
  rounds: ROUNDS,
  cold,
  warm,
};
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${dir}\n  ${bytes.length} bytes, ${JSON.stringify(result.build)}`);
  console.log("  cold start (one sample, ms):");
  for (const [k, v] of Object.entries(cold)) console.log(`    ${k.padEnd(36)} ${v.toFixed(2)}`);
  console.log(`  warm calls (fastest of ${ROUNDS} rounds, microseconds):`);
  for (const [k, v] of Object.entries(warm)) console.log(`    ${k.padEnd(36)} ${v === null ? "n/a" : v.toFixed(1)}`);
}
