/**
 * What a decision says out loud: the press frames a seat sends for one step, shared by the
 * WebSocket client and the arena so both table the same messages and pledges.
 */
import type { Played } from "./player.js";

/** Messages one decision may send. */
export const MESSAGES_PER_STEP = 4;
/** Longest message body sent. */
export const MAX_BODY_CHARS = 1000;

export interface OutgoingPress {
  to: string;
  body: string;
  pledge?: { orders: string[]; sealed: boolean };
}

/**
 * The messages of a decision, cleaned and bounded: at most `MESSAGES_PER_STEP`, none to itself,
 * only to `ALL` in a public-press game, none at all in gunboat. The pledge rides on the first
 * message to its audience and keeps only orders the seat really intends (its validated orders), so
 * a pledge is never a promise about orders the seat is not giving.
 */
export function outgoingPress(played: Pick<Played, "decision" | "validated">, power: string, mode: "full" | "public" | "gunboat"): OutgoingPress[] {
  if (mode === "gunboat") return [];
  const { decision, validated } = played;
  const out: OutgoingPress[] = [];
  let pledged = false;
  for (const msg of decision.messages.slice(0, MESSAGES_PER_STEP)) {
    const to = msg.to.trim().toUpperCase();
    const body = msg.body.trim().slice(0, MAX_BODY_CHARS);
    if (!body || to === power) continue;
    if (mode === "public" && to !== "ALL") continue;
    const orders =
      !pledged && decision.pledge && decision.pledge.to.trim().toUpperCase() === to
        ? decision.pledge.orders.map((o) => o.trim().toUpperCase()).filter((o) => validated.orders.includes(o))
        : [];
    if (orders.length > 0) pledged = true;
    out.push({ to, body, ...(orders.length > 0 ? { pledge: { orders, sealed: decision.pledge!.sealed } } : {}) });
  }
  return out;
}
