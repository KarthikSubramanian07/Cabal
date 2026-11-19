/**
 * Handles: the names players are known by. Pure functions, no I/O.
 *
 * A handle is 3 to 20 letters, digits, `_` or `-`, starting with a letter (the `Handle` schema in
 * @cabal/protocol). It is unique whatever its case: `handleKey` folds it for the unique index. On
 * top of the shape, a light filter refuses names that impersonate the house and the worst abuse.
 * It is deliberately small: it matches whole roots after undoing common letter swaps, so it stops
 * the obvious and does not pretend to moderate. Reports and moderation are a later layer.
 */
import { Handle } from "@cabal/protocol";

/** How long a handle stays fixed after a change. The first change, from a picked-for-you name, is free. */
export const RENAME_COOLDOWN_MS = 14 * 24 * 3600_000;
/** How long a handle a player gave up stays theirs: old links resolve and nobody else can take it. */
export const ALIAS_HOLD_MS = 90 * 24 * 3600_000;

export const handleKey = (handle: string) => handle.trim().toLowerCase();

/** Names that would pass for the house, a system message or an AI seat. Matched exactly. */
const RESERVED = new Set([
  "admin",
  "administrator",
  "anonymous",
  "api",
  "automaton",
  "bot",
  "cabal",
  "claude",
  "everyone",
  "gm",
  "host",
  "me",
  "mod",
  "moderator",
  "null",
  "official",
  "root",
  "server",
  "staff",
  "support",
  "system",
  "undefined",
]);

/** Prefixes that pass for the house however they end: `cabal_official`, `admin2`. */
const RESERVED_PREFIXES = ["admin", "cabal", "moderator", "official", "system"];

/**
 * Words refused anywhere in a handle, after undoing letter swaps. Only words with no innocent use
 * inside a longer name belong here.
 */
const ABUSIVE_ANYWHERE = ["fuck", "nigger", "nigga", "faggot", "hitler"];

/**
 * Words refused as a whole part of a handle (parts split at `_`, `-`, digits and capitals), so
 * `Scunthorpe`, `Therapist`, `Nazir` and `Spicer` are fine while `Big_Cunt` and `NaziGeneral` are not.
 */
const ABUSIVE_WORDS = new Set(["cunt", "shit", "whore", "slut", "nazi", "rapist", "rape", "retard", "spic", "chink", "kike", "pedo", "kkk", "twat"]);

/** Undo the letter swaps people use to dodge a filter: `f4gg0t`, `$h1t`. */
function decode(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4|@/g, "a")
    .replace(/5|\$/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/9/g, "g");
}

export type HandleProblem = "shape" | "reserved" | "abusive";

/** Why a handle may not be used, or null when it may. Uniqueness is the database's job. */
export function handleProblem(handle: string): HandleProblem | null {
  if (!Handle.safeParse(handle).success) return "shape";
  const key = handleKey(handle);
  const bare = key.replace(/[_-]/g, "");
  const decoded = decode(bare);
  if (RESERVED.has(key) || RESERVED.has(bare) || RESERVED.has(decoded)) return "reserved";
  if (RESERVED_PREFIXES.some((prefix) => bare.startsWith(prefix) || decoded.startsWith(prefix))) return "reserved";
  if (ABUSIVE_ANYWHERE.some((word) => decoded.includes(word))) return "abusive";
  const parts = handle
    .trim()
    .split(/[_-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9]{2,})|(?<=[0-9]{2,})(?=[A-Za-z])/)
    .map(decode);
  if (parts.some((part) => ABUSIVE_WORDS.has(part))) return "abusive";
  return null;
}

export const HANDLE_PROBLEMS: Record<HandleProblem, string> = {
  shape: "a handle is 3 to 20 letters, digits, _ or -, and starts with a letter",
  reserved: "that handle is reserved",
  abusive: "that handle is not allowed",
};

const TITLES = ["Envoy", "Courier", "Consul", "Legate", "Attache", "Emissary", "Herald", "Chancellor", "Vizier", "Marshal", "Plenipo", "Archduke", "Cipher", "Ensign"];

/** A handle for a player who did not choose one: `Envoy-4821`. Free to change once. */
export function pickHandle(random: () => number = Math.random): string {
  const title = TITLES[Math.floor(random() * TITLES.length)]!;
  const number = 1000 + Math.floor(random() * 9000);
  return `${title}-${number}`;
}
