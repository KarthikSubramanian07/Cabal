/**
 * Handles: the names players are known by. Pure functions, no I/O.
 *
 * A handle is 3 to 20 letters, digits, `_` or `-`, starting with a letter (the `Handle` schema in
 * @cabal/protocol). It is unique by how it reads, not only whatever its case: `handleKey` folds it
 * to a skeleton for the unique index, so `Envoy_4821` cannot sit beside `Envoy-4821` and `TaIleyrand`
 * (a capital i) beside `Talleyrand`. On top of the shape, a light filter refuses names that
 * impersonate the house and the worst abuse.
 * It is deliberately small: it matches whole roots after undoing common letter swaps, so it stops
 * the obvious and does not pretend to moderate. Reports and moderation are a later layer.
 */
import { Handle } from "@cabal/protocol";

/** How long a handle stays fixed after a change. The first change, from a picked-for-you name, is free. */
export const RENAME_COOLDOWN_MS = 14 * 24 * 3600_000;
/** How long a handle a player gave up stays theirs: old links resolve and nobody else can take it. */
export const ALIAS_HOLD_MS = 90 * 24 * 3600_000;
/**
 * How long a deleted account's handles stay out of reach before anyone may take them. A room that
 * missed the deletion trusts its last word from the index for `ACCOUNTS_FRESH_MS` (room.ts), far
 * less than this, so a stale seat can never link to a newcomer under the same name.
 */
export const DELETED_HANDLE_HOLD_MS = 3600_000;

/**
 * How a handle reads, for uniqueness: lower case, `_` as `-`, and the characters that pass for one
 * another in the interface's sans-serif face folded together (`0` and `o`; `1`, `i` and `l`; `5`
 * and `s`; `rn` and `m`; `vv` and `w`). It is a key only: a handle is always shown as it was typed.
 * Folding again changes nothing, so a key is its own key.
 */
export const handleKey = (handle: string) =>
  handle
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/0/g, "o")
    .replace(/[1i]/g, "l")
    .replace(/5/g, "s")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");

/**
 * Names that would pass for the house, a system message or an AI seat. Matched as the whole handle
 * (trailing digits aside: `Automaton2`), after undoing letter swaps and look-alikes.
 */
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

/** Prefixes that pass for the house however they end: `cabal_official`, `admin2`, `AutomatonPrime`. */
const RESERVED_PREFIXES = ["admin", "anthropic", "automaton", "cabal", "moderator", "official", "system"];

/**
 * Words that pass for the house as one part of a handle (parts split at `_`, `-`, digits and
 * capitals): `Claude_AI`, `Mod_Team`, `Staff1`, `ClaudeBot`. Parts, not prefixes, so `Claudette`,
 * `Modena` and `Stafford` stay fine.
 */
const RESERVED_PARTS = ["admin", "administrator", "anthropic", "automaton", "bot", "cabal", "claude", "mod", "moderator", "official", "staff", "support", "system"];

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

/** Letter swaps undone, then look-alikes folded: what a name reads as, for the reserved checks. */
const fold = (text: string) => handleKey(decode(text));

const RESERVED_FOLDED = new Set([...RESERVED].map(fold));
const RESERVED_PREFIXES_FOLDED = RESERVED_PREFIXES.map(fold);
const RESERVED_PARTS_FOLDED = new Set(RESERVED_PARTS.map(fold));

/** A handle's parts: split at `_` and `-`, at a capital after a small letter, and around digits. */
const partsOf = (handle: string) => handle.trim().split(/[_-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/);

/** The abuse filter's parts: as `partsOf`, but a single digit stays inside its word (`sh1t`). */
const abuseParts = (handle: string) => handle.trim().split(/[_-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9]{2,})|(?<=[0-9]{2,})(?=[A-Za-z])/);

export type HandleProblem = "shape" | "reserved" | "abusive";

/** Why a handle may not be used, or null when it may. Uniqueness is the database's job. */
export function handleProblem(handle: string): HandleProblem | null {
  if (!Handle.safeParse(handle).success) return "shape";
  const bare = handle.trim().toLowerCase().replace(/[_-]/g, "");
  const whole = [fold(bare), fold(bare.replace(/[0-9]+$/, ""))];
  if (whole.some((form) => RESERVED_FOLDED.has(form))) return "reserved";
  if (RESERVED_PREFIXES_FOLDED.some((prefix) => whole[0]!.startsWith(prefix))) return "reserved";
  if (partsOf(handle).some((part) => !/^[0-9]+$/.test(part) && RESERVED_PARTS_FOLDED.has(fold(part)))) return "reserved";
  const decoded = decode(bare);
  if (ABUSIVE_ANYWHERE.some((word) => decoded.includes(word))) return "abusive";
  if (abuseParts(handle).map(decode).some((part) => ABUSIVE_WORDS.has(part))) return "abusive";
  return null;
}

export const HANDLE_PROBLEMS: Record<HandleProblem, string> = {
  shape: "a handle is 3 to 20 letters, digits, _ or -, and starts with a letter",
  reserved: "that handle is reserved",
  abusive: "that handle is not allowed",
};

const TITLES = ["Envoy", "Courier", "Consul", "Legate", "Attache", "Emissary", "Herald", "Chancellor", "Vizier", "Marshal", "Plenipo", "Archduke", "Cipher", "Ensign"];

/** The shape of a picked handle (`pickHandle`), in any case: a title, a dash and four digits. */
const PICKED = new RegExp(`\\b(?:${TITLES.join("|")})-[0-9]{4}\\b`, "gi");

/**
 * Text as it may be logged or sent in an error report, with handles masked as `<handle>` wherever
 * they can be told from other words, the way game codes are masked: in a record's address
 * (`/u/<handle>`, `/players/<handle>`, so `/api/players/<handle>/ratings` too), after the word
 * `handle` with a `:`, `=` or quotes, and in the shape of a handle picked for a guest
 * (`Envoy-4821`), which most players keep. A chosen handle quoted on its own is a word like any
 * other and cannot be told apart, so the pages mask the handles they know before they report.
 */
export function maskHandles(text: string): string {
  return text
    .replace(/(\/(?:u|players)\/)(?!<handle>)[^\s/?#"'`)\]:;,&]+/g, "$1<handle>")
    .replace(/\b(handle\s*(?:[:=]\s*|(?=["'`])))(["'`]?)[A-Za-z][A-Za-z0-9_-]{2,19}\2/gi, "$1$2<handle>$2")
    .replace(PICKED, "<handle>");
}

/** A handle for a player who did not choose one: `Envoy-4821`. Free to change once. */
export function pickHandle(random: () => number = Math.random): string {
  const title = TITLES[Math.floor(random() * TITLES.length)]!;
  const number = 1000 + Math.floor(random() * 9000);
  return `${title}-${number}`;
}
