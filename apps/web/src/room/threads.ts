/**
 * Press as threads: the table (everything sent to `ALL`) and one private thread per other power.
 * Pure, so the grouping, the unread counts and the whisper budget are tested without React.
 */
import type { GameSettings, GameStatus, PowerName, PressView, Recipient } from "@cabal/protocol";
import { POWERS } from "../lobby/terms.js";

export interface Thread {
  /** `ALL` for the table, else the other power. */
  id: Recipient;
  messages: PressView[];
  unread: number;
  /** When the newest message was sent; 0 for an empty thread. */
  last: number;
}

/** The thread a message belongs to, as `me` sees it. */
export function threadOf(message: Pick<PressView, "from" | "to">, me: PowerName | null): Recipient {
  if (message.to === "ALL") return "ALL";
  if (me && message.from === me) return message.to;
  return message.from;
}

/** Whether a game allows private threads at all. */
export function privatePress(settings: Pick<GameSettings, "press">): boolean {
  return settings.press === "full";
}

/**
 * Every thread `me` can read or write, the table first, then the other powers in board order.
 * A spectator, and every player in a public-press game, has only the table.
 */
export function threadList(press: readonly PressView[], me: PowerName | null, settings: Pick<GameSettings, "press">, unread: Record<string, number>): Thread[] {
  const ids: Recipient[] = ["ALL", ...(me && privatePress(settings) ? POWERS.filter((p) => p !== me) : [])];
  const byId = new Map<Recipient, PressView[]>(ids.map((id) => [id, []]));
  for (const m of press) {
    const id = threadOf(m, me);
    // A private message a spectator could never see, or one from a game that later went public.
    byId.get(id)?.push(m);
  }
  return ids.map((id) => {
    const messages = byId.get(id) ?? [];
    return { id, messages, unread: unread[id] ?? 0, last: messages.at(-1)?.sentAt ?? 0 };
  });
}

export function totalUnread(threads: readonly Thread[]): number {
  return threads.reduce((n, t) => n + t.unread, 0);
}

/** Private messages `me` may still send this phase; null when there is no budget. */
export function whispersLeft(press: readonly PressView[], me: PowerName, phase: string, budget: number | null): number | null {
  if (budget === null) return null;
  const sent = press.filter((m) => m.from === me && m.phase === phase && m.to !== "ALL" && m.to !== me).length;
  return Math.max(0, budget - sent);
}

/**
 * Whether press may be written now, and if not, why, in the words the composer shows. The server
 * makes the same checks; this only keeps a player from writing something that will bounce.
 */
export function pressOpen(settings: Pick<GameSettings, "press" | "rulebookPress">, status: GameStatus, phase: string, to: Recipient): { open: boolean; why: string | null } {
  if (status === "lobby") return to === "ALL" ? { open: true, why: null } : { open: false, why: "Before the game starts, everything is said to the whole table." };
  if (status !== "active") return { open: false, why: status === "paused" ? "The game is paused. Press opens again when it resumes." : "The game is over. The press is kept as it was." };
  if (settings.press === "gunboat") return { open: false, why: "Gunboat: nobody writes once the game has started." };
  if (settings.press === "public" && to !== "ALL") return { open: false, why: "Public press: everything is said to the whole table." };
  if (settings.rulebookPress && !phase.endsWith("M")) return { open: false, why: "Rulebook press: the table is silent during retreats and adjustments." };
  return { open: true, why: null };
}

/** The short label for a thread: `The table` or the power's name. */
export function threadLabel(id: Recipient): string {
  return id === "ALL" ? "The table" : id[0] + id.slice(1).toLowerCase();
}
