/**
 * The guest account this device holds: the player's id and handle, and the secret the server
 * issued when the account was made (or restored here from a recovery code). The secret is a
 * credential. It lives in localStorage and nowhere else; it travels only as a bearer header and
 * never in a URL, a link or a log. The server keeps only its hash.
 *
 * Storage can be missing or refuse writes (private windows, blocked site data), so every access is
 * guarded; a device that cannot store the secret still plays, signed in for this visit only.
 */
const KEY = "cabal.player";
const CHANGE = "cabal:player";

export interface StoredPlayer {
  id: string;
  handle: string;
  secret: string;
  /** When this device signed in, ms since the epoch. */
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The account held for this visit when storage refused it. */
let volatile: StoredPlayer | null = null;
/** The last value read, so the same object comes back until something changes (useSyncExternalStore). */
let cached: { raw: string | null; value: StoredPlayer | null } | null = null;

export function parsePlayer(raw: string | null): StoredPlayer | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof StoredPlayer, unknown>> | null;
    if (!v || typeof v !== "object") return null;
    const text = (x: unknown): x is string => typeof x === "string" && x !== "";
    if (!text(v.id) || !text(v.handle) || !text(v.secret)) return null;
    return { id: v.id, handle: v.handle, secret: v.secret, savedAt: typeof v.savedAt === "number" ? v.savedAt : 0 };
  } catch {
    return null;
  }
}

export function readPlayer(): StoredPlayer | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return volatile;
  if (cached && cached.raw === raw) return cached.value;
  cached = { raw, value: parsePlayer(raw) };
  return cached.value;
}

function changed(): void {
  try {
    window.dispatchEvent(new Event(CHANGE));
  } catch {
    // no window (tests)
  }
}

/** Keep the account on this device. Returns false when storage refused (it then lasts this visit only). */
export function savePlayer(player: Omit<StoredPlayer, "savedAt"> & { savedAt?: number }): boolean {
  const value: StoredPlayer = { id: player.id, handle: player.handle, secret: player.secret, savedAt: player.savedAt ?? Date.now() };
  let stored = false;
  try {
    const store = storage();
    if (store) {
      store.setItem(KEY, JSON.stringify(value));
      stored = true;
    }
  } catch {
    stored = false;
  }
  volatile = stored ? null : value;
  changed();
  return stored;
}

/** The handle changed on the server: keep the secret, change the name. */
export function renameStoredPlayer(handle: string): void {
  const current = readPlayer();
  if (current) savePlayer({ ...current, handle });
}

export function forgetPlayer(): void {
  volatile = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // nothing to forget
  }
  changed();
}

/** Re-run `onChange` when the account changes in this tab or another. */
export function subscribePlayer(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) onChange();
  };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Recovery codes are long; people copy them with spaces, dashes, line breaks and the odd
 * lower-case letter. The server compares a canonical form, so send it the code as written,
 * trimmed of the whitespace around it and inside it.
 */
export function tidyRecoveryCode(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

/** What goes in the file a player keeps their recovery code in. */
export function recoveryFile(handle: string, code: string, issuedAt: number, origin: string): string {
  const day = new Date(issuedAt).toISOString().slice(0, 10);
  return [
    "Cabal recovery code",
    "",
    `Handle: ${handle}`,
    `Issued: ${day}`,
    "",
    code,
    "",
    `To use this account on another device, open ${origin}, choose Restore an account from the player menu, and enter the code above.`,
    "Anyone with this code can play as you. Keep it somewhere private. Issuing a new code makes this one stop working.",
    "",
  ].join("\n");
}
