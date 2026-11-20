/**
 * The seats this device holds. A seat token is a credential: it lives in localStorage under the
 * game's code and nowhere else. It never goes into a URL, a link or a log; the socket presents it
 * in its first `hello` frame and HTTP calls send it as a bearer header.
 *
 * Storage can be missing or refuse writes (private windows, blocked site data), so every access
 * is guarded and a failure reads as "no seat here".
 */
import type { PowerName } from "@cabal/protocol";
import { forgetDrafts } from "../room/drafts.js";
import { isGameCode } from "./code.js";

/** The seven powers, here rather than from the protocol's schemas so the shell can read seats cheaply. */
const POWERS: ReadonlySet<string> = new Set(["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]);

const PREFIX = "cabal.seat.";
const NAME_KEY = "cabal.name";

export interface HeldSeat {
  gameId: string;
  power: PowerName;
  token: string;
  /** The name this device sat down under. */
  name: string;
  /**
   * The account that took the seat, when one did. Signing that account out of this device
   * forgets the seat with it, so the next person at the device cannot play as them.
   */
  userId?: string | null;
  /** When the seat was taken, ms since the epoch. */
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parse(gameId: string, raw: string | null): HeldSeat | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HeldSeat>;
    if (typeof value.power !== "string" || !POWERS.has(value.power) || typeof value.token !== "string" || value.token === "") return null;
    // A token names its own game: one copied under the wrong key is not this game's seat.
    if (!value.token.startsWith(`${gameId}.`)) return null;
    return {
      gameId,
      power: value.power as PowerName,
      token: value.token,
      name: typeof value.name === "string" ? value.name : "",
      userId: typeof value.userId === "string" ? value.userId : null,
      savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function readSeat(gameId: string): HeldSeat | null {
  const store = storage();
  if (!store) return null;
  try {
    return parse(gameId, store.getItem(PREFIX + gameId));
  } catch {
    return null;
  }
}

/** Keep a seat. Returns false when the device would not store it (the seat then lasts this visit only). */
export function saveSeat(seat: Omit<HeldSeat, "savedAt"> & { savedAt?: number }): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const value: HeldSeat = { ...seat, savedAt: seat.savedAt ?? Date.now() };
    store.setItem(PREFIX + seat.gameId, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Let go of a seat, and of any orders it wrote here that never reached the server. */
export function forgetSeat(gameId: string): void {
  try {
    storage()?.removeItem(PREFIX + gameId);
  } catch {
    // nothing to forget
  }
  forgetDrafts(gameId);
}

/** Every seat this device holds, newest first. */
export function listSeats(): HeldSeat[] {
  const store = storage();
  if (!store) return [];
  const out: HeldSeat[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const gameId = key.slice(PREFIX.length);
      if (!isGameCode(gameId)) continue;
      const seat = parse(gameId, store.getItem(key));
      if (seat) out.push(seat);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Forget every seat an account took on this device: those it is recorded as taking, and older
 * ones taken under its handle before seats recorded their account. Seats somebody took without
 * an account stay.
 */
export function forgetSeatsOf(account: { id: string; handle: string }): string[] {
  const handle = account.handle.toLowerCase();
  const gone = listSeats()
    .filter((s) => s.userId === account.id || (!s.userId && s.name !== "" && s.name.toLowerCase() === handle))
    .map((s) => s.gameId);
  for (const gameId of gone) forgetSeat(gameId);
  return gone;
}

/** The name this device last sat down under, so nobody types it twice. */
export function readName(): string {
  try {
    return storage()?.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    storage()?.setItem(NAME_KEY, name.trim());
  } catch {
    // remembered for this visit only
  }
}
