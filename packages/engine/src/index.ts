/**
 * @cabal/engine: the Cabal rules engine, compiled from Rust to WebAssembly.
 *
 * The same module runs in the browser and in Cloudflare Workers. Call `ready()`
 * once with a source for the `.wasm` bytes (a URL in the browser, a compiled
 * `WebAssembly.Module` in workerd, a Buffer in Node), then use the exports.
 *
 * All values are MILA shaped strings: units `A PAR`, `F STP/NC`; phases `S1901M`;
 * powers `FRANCE`; orders `A PAR - BUR`, `F NTH C A LON - BRE`, `A LON - BRE VIA`.
 */
import init, * as wasm from "../pkg/cabal_engine.js";

export type {
  AdjustOptions,
  AttackInfo,
  BotDecision,
  BotFear,
  BotIntent,
  BotSupport,
  BuildInfo,
  BuildOption,
  ConvoyInfo,
  ConvoyOption,
  CycleInfo,
  DislodgedInfo,
  DislodgedRecord,
  Divergence,
  EngineInfo,
  Explanation,
  LegalMoves,
  LegalOrders,
  LegalOrdersByPower,
  MapInfo,
  MoveOption,
  OppositionInfo,
  OrderExplanation,
  OrderResult,
  OrderVerdict,
  OrderVerdicts,
  OrdersByPower,
  PhaseOutcome,
  PledgeRecord,
  PowerInfo,
  PressMessage,
  ProvinceInfo,
  RejectedOrder,
  ReplayReport,
  State,
  StateExtras,
  SupportInfo,
  SupportOption,
  UnitMoves,
  UnitStrength,
} from "../pkg/cabal_engine.js";

export { Game } from "../pkg/cabal_engine.js";

export type InitSource =
  | string
  | URL
  | Request
  | Response
  | BufferSource
  | WebAssembly.Module
  | Promise<Response>;

let loading: Promise<void> | undefined;

/** Initialise the engine once. Safe to call repeatedly. */
export function ready(source?: InitSource): Promise<void> {
  loading ??= init(
    source === undefined ? undefined : { module_or_path: source as never },
  ).then(() => undefined);
  return loading;
}

/** Engine version (semantic version of the Rust crate). */
export const version = (): string => wasm.version();

/** Name of a bundled map, for `new Game(rulebook, map)` and `mapInfo(map)`. */
export type MapName = "standard" | "duel";

/**
 * Static description of a bundled map: powers, provinces, adjacency. The
 * standard map unless `map` names another (`duel`).
 */
export const mapInfo = (map?: MapName): wasm.MapInfo => wasm.map_info(map);

/**
 * What this build of the engine is: version, the commit it was built from,
 * profile, optimisation level, target, bundled maps, rulebook editions and a
 * list of capabilities. Meant for `/health` endpoints and bug reports.
 */
export const buildInfo = (): wasm.EngineInfo => wasm.buildInfo();

/**
 * What-if: the outcome a set of orders would have from `state`, with no game to
 * keep and nothing mutated. Any phase kind and any hypothetical order set work;
 * units left without an order hold (in retreats, disband). Orders that cannot
 * be adjudicated at all come back in `rejected` instead of throwing.
 *
 * With a `Game` at hand, `game.preview(orders)` asks the same of its current
 * position without sending the state across.
 */
export const preview = (
  state: wasm.State,
  orders: wasm.OrdersByPower,
  rulebook?: string,
  map?: MapName,
): wasm.PhaseOutcome => wasm.preview(state, orders, rulebook, map);

/**
 * What-if with reasons: for every unit one plain-English sentence, the units
 * responsible, the strengths it was judged on, cut supports, broken convoys and
 * paradox cycles. Movement phases only. `game.explain(index)` gives the same
 * for a phase already played, `game.explainPreview(orders)` for the current one.
 */
export const explainPreview = (
  state: wasm.State,
  orders: wasm.OrdersByPower,
  rulebook?: string,
  map?: MapName,
): wasm.Explanation => wasm.explainPreview(state, orders, rulebook, map);

/**
 * Judge orders against the board of `state`: one verdict per order, in order,
 * with canonical text, `legal`, a machine `code` and a `reason` sentence.
 * Unlike `canonicalOrder` this looks at the board, so `A PAR - MOS` comes back
 * `unreachable`. Never throws over an order. `game.validateOrders(power,
 * orders)` does the same for a game's current phase.
 */
export const validateOrders = (
  state: wasm.State,
  power: string,
  orders: string[],
  rulebook?: string,
  map?: MapName,
): wasm.OrderVerdicts =>
  wasm.validateOrders(state, power, orders, rulebook, map);

/**
 * Canonical MILA text for an order, or throws when it does not parse. Phase kind
 * is `M`, `R` or `A`. Syntax only: no board is consulted, so an impossible order
 * still canonicalises. Use `validateOrders` to know whether it is legal.
 */
export const canonicalOrder = (
  text: string,
  phaseKind: "M" | "R" | "A",
  power: string,
  map?: MapName,
): string => wasm.canonicalOrder(text, phaseKind, power, map);

/** Strength of the built-in heuristic bot. */
export type BotLevel = "easy" | "standard" | "hard";

export interface BotOptions {
  /**
   * Any stable value, usually the game id. The same game state, power, seed and
   * level always give the same decision; the seed is mixed with the phase and
   * the power, so one seed serves a whole game.
   */
  seed: string | number;
  /** Defaults to `standard`. */
  level?: BotLevel;
}

/**
 * Orders for `power` in the game's current phase from the built-in heuristic bot
 * (the Rust crate `cabal-bot`, compiled into this module): one legal order per
 * unit, builds and disbands filled to the allowance, plus a short `intent`
 * (targets, supports, fears) for press and the UI. No network, no model, and a
 * few milliseconds at the default level. Throws when the game is finished or the
 * power or level is unknown.
 */
export const botOrders = (
  game: wasm.Game,
  power: string,
  options: BotOptions,
): wasm.BotDecision =>
  game.botOrders(power, String(options.seed), options.level);

/** A seal: BLAKE3 commitment over canonical orders plus a hex nonce. */
export const pledgeCommit = (orders: string[], nonceHex: string): string =>
  wasm.pledgeCommit(orders, nonceHex);

/** Does a commitment open with these orders and nonce? */
export const pledgeOpens = (
  commitment: string,
  orders: string[],
  nonceHex: string,
): boolean => wasm.pledgeOpens(commitment, orders, nonceHex);

/**
 * Replay a saved game (JSON text) and report every divergence from the record:
 * orders, results, dislodgements, phase names, units, centres, retreats, builds
 * and the outcome. `divergences` is empty when the engine reproduces the file.
 * Throws only when the file cannot be replayed at all.
 *
 * This is the explicit check. Loading a game you trust does not need it:
 * `Game.resume(saved)` and `Game.fromSnapshot(snapshot, saved)` adjudicate
 * nothing from the past, so they keep working across engine upgrades.
 */
export const verifySaved = (
  saved: string,
  rulebook?: string,
): wasm.ReplayReport => wasm.verifySaved(saved, rulebook);

/**
 * A receipt from order text alone: `kept`, `broken` or `void`. It cannot tell
 * silence from having nothing to order, so an empty submission is `void`.
 * With a game at hand use `game.pledgeReceipt(index, power, pledged, submitted)`,
 * which judges against the board and calls that silence `broken`.
 */
export const pledgeReceipt = (
  pledged: string[],
  submitted: string[],
): "kept" | "broken" | "void" =>
  wasm.pledgeReceipt(pledged, submitted) as "kept" | "broken" | "void";

/** Random 16 byte nonce as hex, for seals. */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The seven classic powers in MILA naming. */
export const POWERS = [
  "AUSTRIA",
  "ENGLAND",
  "FRANCE",
  "GERMANY",
  "ITALY",
  "RUSSIA",
  "TURKEY",
] as const;
export type PowerName = (typeof POWERS)[number];
