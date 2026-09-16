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
  BuildInfo,
  DislodgedInfo,
  LegalOrders,
  MapInfo,
  OrderResult,
  OrdersByPower,
  PhaseOutcome,
  PowerInfo,
  ProvinceInfo,
  State,
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

/** Static description of the standard map: powers, provinces, adjacency. */
export const mapInfo = (): wasm.MapInfo => wasm.map_info();

/** Adjudicate one movement phase from a state without keeping history. */
export const preview = (
  state: wasm.State,
  orders: wasm.OrdersByPower,
  rulebook?: string,
): wasm.PhaseOutcome => wasm.preview(state, orders, rulebook);

/** Canonical MILA text for an order, or throws when it does not parse. Phase kind is `M`, `R` or `A`. */
export const canonicalOrder = (
  text: string,
  phaseKind: "M" | "R" | "A",
  power: string,
): string => wasm.canonicalOrder(text, phaseKind, power);

/** A seal: BLAKE3 commitment over canonical orders plus a hex nonce. */
export const pledgeCommit = (orders: string[], nonceHex: string): string =>
  wasm.pledgeCommit(orders, nonceHex);

/** Does a commitment open with these orders and nonce? */
export const pledgeOpens = (
  commitment: string,
  orders: string[],
  nonceHex: string,
): boolean => wasm.pledgeOpens(commitment, orders, nonceHex);

/** A receipt: `kept`, `broken` or `void`. */
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
