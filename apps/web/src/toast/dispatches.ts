/**
 * Dispatches: the short slips the room pins up when something happens in a part of it the player
 * is not looking at. A phase resolved, a seal was opened and stamped, a message came in for a
 * thread that is not on screen. Pure, so what earns a slip (and what does not) is tested without
 * React: the room's view before a frame and after it go in, the slips come out.
 */
import type { PowerName, Receipt, Recipient } from "@cabal/protocol";
import { phaseLabel, powerLabel } from "../lobby/terms.js";
import type { RoomView } from "../lobby/room.js";
import { threadOf } from "../room/threads.js";

export type DispatchKind = "resolved" | "press" | "receipt";

export interface Dispatch {
  /** Stable per subject: news about one thread replaces the slip already up for it. */
  key: string;
  kind: DispatchKind;
  /** The power whose colour heads the slip; null for news about the whole table. */
  power: PowerName | null;
  title: string;
  line: string;
  /** The stamp on a receipt's slip. */
  stamp: Receipt | null;
  /** The thread the slip's action opens, for press and receipts. */
  thread: Recipient | null;
  /** How many messages the slip stands for (press only; 1 otherwise). */
  count: number;
  /** What a screen reader is told; null when the room already says it another way. */
  say: string | null;
}

/** How much of a message a slip shows. */
export const LINE_CHARS = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= LINE_CHARS ? flat : `${chars.slice(0, LINE_CHARS - 1).join("").trimEnd()}…`;
}

const RECEIPT_LINE: Record<Receipt, string> = {
  kept: "Every order under it was given as promised.",
  broken: "The orders given were not the ones promised.",
  void: "It came to nothing: there was nothing for it to bind.",
};

export interface DispatchContext {
  /** The viewer's seat; null for a spectator. */
  me: PowerName | null;
  /** The thread the player is reading right now; null when press is not on screen. */
  reading: Recipient | null;
}

/** The slips one change of the room earns, oldest news first. */
export function roomDispatches(before: RoomView, after: RoomView, ctx: DispatchContext): Dispatch[] {
  if (before.gameId !== after.gameId) return [];
  const out: Dispatch[] = [];

  // A phase resolved. The room already says so out loud with the failures counted, so the slip is
  // for the eyes only.
  const phase = after.lastResolved;
  if (phase && phase !== before.lastResolved) {
    const results = after.resolved[phase]?.results ?? [];
    const mine = ctx.me ? results.filter((r) => r.power === ctx.me && r.code !== "disband") : [];
    const failed = mine.filter((r) => !r.ok).length;
    out.push({
      key: "resolved",
      kind: "resolved",
      power: null,
      title: `${phaseLabel(phase)} resolved`,
      line:
        mine.length === 0
          ? "The results are on the board."
          : failed === 0
            ? `${mine.length === 1 ? "Your order" : `All ${mine.length} of your orders`} succeeded.`
            : `${failed} of your ${mine.length} ${mine.length === 1 ? "order" : "orders"} failed.`,
      stamp: null,
      thread: null,
      count: 1,
      say: null,
    });
  }

  // Seals opened: a receipt stamped on a pledge this device could already see.
  const had = new Map(before.press.map((m) => [m.id, m]));
  for (const m of after.press) {
    const pledge = m.pledge;
    if (!pledge?.receipt) continue;
    const old = had.get(m.id);
    if (!old || old.pledge?.receipt) continue;
    const thread = threadOf(m, ctx.me);
    const by = pledge.pledger === ctx.me ? "Your seal" : `${powerLabel(pledge.pledger)}'s seal`;
    const to = pledge.audience === "ALL" ? "the table" : pledge.audience === ctx.me ? "you" : powerLabel(pledge.audience);
    const title = `${by} to ${to}`;
    out.push({
      key: `receipt:${pledge.id}`,
      kind: "receipt",
      power: pledge.pledger,
      title,
      line: RECEIPT_LINE[pledge.receipt],
      stamp: pledge.receipt,
      thread,
      count: 1,
      say: `${title}: ${pledge.receipt}. ${RECEIPT_LINE[pledge.receipt]}`,
    });
  }

  // Messages from others for a thread that is not on screen, one slip per thread.
  const fresh = after.press.filter((m) => !had.has(m.id) && m.from !== ctx.me);
  const byThread = new Map<Recipient, typeof fresh>();
  for (const m of fresh) {
    const thread = threadOf(m, ctx.me);
    if (thread === ctx.reading) continue;
    byThread.set(thread, [...(byThread.get(thread) ?? []), m]);
  }
  for (const [thread, list] of byThread) {
    const last = list.at(-1)!;
    out.push(pressSlip(thread, last.from, last.body, list.length));
  }
  return out;
}

function pressSlip(thread: Recipient, from: PowerName, body: string, count: number): Dispatch {
  const who = powerLabel(from);
  const title = thread === "ALL" ? `${who} to the table` : count > 1 ? `${count} dispatches from ${who}` : `Dispatch from ${who}`;
  return {
    key: `press:${thread}`,
    kind: "press",
    power: from,
    title,
    line: clip(body),
    stamp: null,
    thread,
    count,
    say: thread === "ALL" ? `${who} wrote to the table.` : count > 1 ? `${count} new dispatches from ${who}.` : `New dispatch from ${who}.`,
  };
}

/**
 * Pin new slips over the ones already up: news about a thread already on a slip adds to it (the
 * count grows and the newest words show), anything else goes on top, and only the newest `max`
 * stay up.
 */
export function pinDispatches(up: readonly Dispatch[], news: readonly Dispatch[], max = 3): Dispatch[] {
  let next = [...up];
  for (const d of news) {
    const at = next.findIndex((x) => x.key === d.key);
    if (at >= 0 && d.kind === "press") {
      const count = next[at]!.count + d.count;
      const merged = pressSlip(d.thread!, d.power!, "", count);
      next.splice(at, 1);
      next.push({ ...merged, line: d.line });
    } else {
      if (at >= 0) next.splice(at, 1);
      next.push(d);
    }
  }
  if (next.length > max) next = next.slice(next.length - max);
  return next;
}
