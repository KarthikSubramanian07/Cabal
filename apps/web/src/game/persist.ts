/**
 * Autosave for the sandbox. The game is written to localStorage after every order and
 * every adjudication, and read back on load, so a reload, a crashed tab or a stray tap on
 * the wordmark does not cost the player their game.
 *
 * The stored shape carries a schema number. A save written by a newer or older build that
 * this one cannot read is left alone and ignored, never half-loaded.
 */
import type { OrderBook } from "./book.js";

export const SAVE_KEY = "cabal.sandbox";
export const SAVE_SCHEMA = 1;

export interface SandboxSave {
  schema: typeof SAVE_SCHEMA;
  /** Milliseconds since the epoch. */
  savedAt: number;
  /** The game so far in the MILA saved-game format, exactly what Export writes. */
  game: string;
  /** Orders written for the phase in progress, not yet adjudicated. */
  orders: OrderBook;
  /** The power whose orders were open. */
  active: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isOrderBook(value: unknown): value is OrderBook {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entries) =>
      typeof entries === "object" &&
      entries !== null &&
      !Array.isArray(entries) &&
      Object.values(entries).every((text) => typeof text === "string"),
  );
}

export function encodeSave(save: Omit<SandboxSave, "schema">): string {
  return JSON.stringify({ schema: SAVE_SCHEMA, ...save });
}

/** Parse a stored save. Anything malformed, or from another schema, is null. */
export function decodeSave(raw: string | null | undefined): SandboxSave | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d["schema"] !== SAVE_SCHEMA) return null;
  if (typeof d["game"] !== "string" || d["game"].length === 0) return null;
  if (typeof d["savedAt"] !== "number" || !Number.isFinite(d["savedAt"])) return null;
  if (typeof d["active"] !== "string") return null;
  if (!isOrderBook(d["orders"])) return null;
  return { schema: SAVE_SCHEMA, savedAt: d["savedAt"], game: d["game"], orders: d["orders"], active: d["active"] };
}

function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be blocked outright (some private windows, sandboxed frames).
    return null;
  }
}

export function readSave(from: Store | null = store()): SandboxSave | null {
  try {
    return decodeSave(from?.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

/** Returns false when the save could not be written (storage full or unavailable). */
export function writeSave(save: Omit<SandboxSave, "schema">, to: Store | null = store()): boolean {
  try {
    if (!to) return false;
    to.setItem(SAVE_KEY, encodeSave(save));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(from: Store | null = store()): void {
  try {
    from?.removeItem(SAVE_KEY);
  } catch {
    // nothing to clear
  }
}

/** Thrown by import when a file is not a game this build can load. `message` is safe to show. */
export class ImportError extends Error {
  /** The parser's or engine's own words, for the curious. */
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "ImportError";
    this.detail = detail;
  }
}

export interface SavedGameFile {
  phases: { name: string; state: unknown; orders: Record<string, string[]> }[];
}

/**
 * Check that text is a saved game before the engine sees it, so a wrong file gets a plain
 * sentence and not a JSON parser position.
 */
export function parseSavedGame(text: string): SavedGameFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ImportError("That file is not a Cabal game export. It is not JSON.", err instanceof Error ? err.message : String(err));
  }
  const phases = (data as { phases?: unknown } | null)?.phases;
  if (typeof data !== "object" || data === null || !Array.isArray(phases) || phases.length === 0) {
    throw new ImportError("That file is not a Cabal game export. It has no phases in it.", "expected an object with a non-empty `phases` list");
  }
  for (const [i, phase] of phases.entries()) {
    const p = phase as { name?: unknown; state?: unknown; orders?: unknown } | null;
    if (typeof p !== "object" || p === null || typeof p.name !== "string" || typeof p.state !== "object" || p.state === null) {
      throw new ImportError("That file is not a Cabal game export. One of its phases is incomplete.", `phase ${i} is missing a name or a state`);
    }
  }
  return data as SavedGameFile;
}
