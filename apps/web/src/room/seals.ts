/**
 * Seals: a pledge is sealed on this device. The device draws the nonce, commits to the orders
 * with BLAKE3 (`pledgeCommit`, the engine's own), and sends both, so the server can only accept
 * exactly the seal that was made here. When the phase resolves the server reveals the orders and
 * the nonce, and every reader opens the seal again on their own device.
 *
 * Honest about what that proves: the server sees the orders when they are pledged (it must, to
 * stamp the receipt), so a seal protects a player from the other players, not from the server.
 */
import type { OrderResultView, PledgeInput, PledgeView } from "@cabal/protocol";
import { pledgeCommit, pledgeOpens, randomNonce } from "../engine.js";
import { parseOrder } from "../game/notation.js";

/** A pledge as it is sent: orders, the nonce drawn here, and the commitment made here. */
export interface Seal extends PledgeInput {
  orders: string[];
  sealed: boolean;
  nonce: string;
  commitment: string;
}

/** Make a pledge for `orders` (canonical text, as the engine listed them). */
export function makeSeal(orders: readonly string[], sealed: boolean, nonce: string = randomNonce()): Seal {
  const list = [...orders];
  return { orders: list, sealed, nonce, commitment: pledgeCommit(list, nonce) };
}

export type SealCheck =
  /** Nothing to check yet: the orders or the nonce are still the pledger's secret. */
  | "closed"
  /** The revealed orders and nonce produce exactly the commitment everyone saw. */
  | "opens"
  /** They do not: what was revealed is not what was sealed. */
  | "fails";

/** Open a pledge's seal on this device, when its orders and nonce are known. */
export function checkSeal(pledge: Pick<PledgeView, "commitment" | "orders" | "nonce">): SealCheck {
  if (!pledge.orders || !pledge.nonce) return "closed";
  try {
    return pledgeOpens(pledge.commitment, pledge.orders, pledge.nonce) ? "opens" : "fails";
  } catch {
    return "fails";
  }
}

export type ReceiptCheck = "agrees" | "disagrees" | "unknown";

/**
 * Hold the server's receipt up against the adjudication this device received. `results` are the
 * phase's results (every power's adjudicated orders); null when this device did not see them.
 *
 * Kept means every pledged order was carried out as written, so each must appear among the
 * pledger's adjudicated orders. Broken means at least one was not: if every pledged order
 * appears and none of them is a hold (which a silent unit also does), the receipt is wrong.
 * Void binds nothing and is not checked.
 */
export function checkReceipt(pledge: Pick<PledgeView, "pledger" | "orders" | "receipt">, results: readonly OrderResultView[] | null): ReceiptCheck {
  if (!pledge.receipt || !pledge.orders || !results || pledge.receipt === "void") return "unknown";
  const done = new Set(results.filter((r) => r.power === pledge.pledger).map((r) => r.order));
  if (done.size === 0) return "unknown";
  const all = pledge.orders.every((o) => done.has(o));
  if (pledge.receipt === "kept") return all ? "agrees" : "disagrees";
  const holds = pledge.orders.some((o) => parseOrder(o)?.type === "hold");
  return all && !holds ? "disagrees" : "agrees";
}

/** The first and last few characters of a commitment, the way it is read aloud. */
export function shortCommitment(commitment: string): string {
  return commitment.length > 12 ? `${commitment.slice(0, 6)}…${commitment.slice(-4)}` : commitment;
}
