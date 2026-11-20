/**
 * Orders written on this device that the server does not have yet, kept in localStorage so that
 * leaving the room (or losing the tab) before the connection comes back does not lose them.
 *
 * One draft per game and seat, for one phase: `cabal.draft.<game>.<power>`. A draft is written
 * while a change waits to be filed, dropped once the server has acknowledged it, and ignored and
 * dropped when the phase it was written for is over. Storage can be missing or refuse writes
 * (private windows, blocked site data, a full quota): every access is guarded, and a failure only
 * means the orders last this visit, as they did before.
 */

export const DRAFT_PREFIX = "cabal.draft.";
/** The stored shape. A draft of another version is ignored. */
const VERSION = 1;
/** A draft this old belongs to a game long gone: swept when another is written. */
export const DRAFT_TTL_MS = 30 * 86_400_000;

export interface Draft {
  gameId: string;
  power: string;
  /** The phase the orders were written for (`S1901M`). */
  phase: string;
  /** The seat's orders, keyed as the order book keys them. */
  book: Record<string, string>;
  savedAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function storage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const draftKey = (gameId: string, power: string) => `${DRAFT_PREFIX}${gameId}.${power}`;

/** A stored draft, or null for anything malformed or of another version. */
export function decodeDraft(raw: string | null | undefined): Draft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d["v"] !== VERSION) return null;
  if (typeof d["gameId"] !== "string" || typeof d["power"] !== "string" || typeof d["phase"] !== "string") return null;
  if (typeof d["savedAt"] !== "number" || !Number.isFinite(d["savedAt"])) return null;
  const book = d["book"];
  if (typeof book !== "object" || book === null || Array.isArray(book)) return null;
  if (!Object.values(book).every((text) => typeof text === "string")) return null;
  return { gameId: d["gameId"], power: d["power"], phase: d["phase"], book: book as Record<string, string>, savedAt: d["savedAt"] };
}

/**
 * The draft for this seat and phase. One left from an earlier phase is over and done with: it is
 * removed, and null is returned.
 */
export function readDraft(gameId: string, power: string, phase: string, from: Store | null = storage()): Draft | null {
  if (!from) return null;
  try {
    const key = draftKey(gameId, power);
    const draft = decodeDraft(from.getItem(key));
    if (!draft || draft.gameId !== gameId || draft.power !== power || draft.phase !== phase) {
      // Over (another phase) or unreadable: gone either way.
      from.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** Keep a draft. Returns false when the device would not store it. */
export function writeDraft(draft: Draft, to: Store | null = storage()): boolean {
  if (!to) return false;
  try {
    to.setItem(draftKey(draft.gameId, draft.power), JSON.stringify({ v: VERSION, ...draft }));
  } catch {
    return false;
  }
  sweepDrafts(draft.savedAt, to);
  return true;
}

export function clearDraft(gameId: string, power: string, from: Store | null = storage()): void {
  try {
    from?.removeItem(draftKey(gameId, power));
  } catch {
    // nothing to clear
  }
}

/** Every draft of a game this device is letting go of (the seat forgotten, the account signed out). */
export function forgetDrafts(gameId: string, from: Store | null = storage()): void {
  if (!from) return;
  for (const key of draftKeys(from)) if (key.startsWith(`${DRAFT_PREFIX}${gameId}.`)) clearKey(from, key);
}

/** Drafts older than the TTL, or unreadable, are removed. */
export function sweepDrafts(now: number, from: Store | null = storage()): void {
  if (!from) return;
  for (const key of draftKeys(from)) {
    let draft: Draft | null = null;
    try {
      draft = decodeDraft(from.getItem(key));
    } catch {
      continue;
    }
    if (!draft || now - draft.savedAt > DRAFT_TTL_MS) clearKey(from, key);
  }
}

function draftKeys(from: Store): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < from.length; i++) {
      const key = from.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
  } catch {
    // whatever was listed
  }
  return keys;
}

function clearKey(from: Store, key: string) {
  try {
    from.removeItem(key);
  } catch {
    // left for the next sweep
  }
}
