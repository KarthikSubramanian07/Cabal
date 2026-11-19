/**
 * Game codes. The server deals six characters from an alphabet with no look-alikes
 * (apps/server/src/tokens.ts): no I, O, 0 or 1. People read codes aloud, paste whole links
 * and type in lower case, so the parser forgives all three.
 */

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

const CODE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** True for a well formed code in canonical (upper case) form. */
export function isGameCode(value: string): boolean {
  return CODE.test(value);
}

/**
 * Pull a game code out of whatever was typed or pasted: `k7q2xz`, `K7Q2 XZ`, `K7Q-2XZ`, or a link
 * such as `https://playcabal.pages.dev/g/K7Q2XZ`. Returns null when there is no code in it.
 */
export function parseGameCode(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const link = /\/g\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(text);
  const candidate = (link ? link[1]! : text).replace(/[\s-]+/g, "").toUpperCase();
  return isGameCode(candidate) ? candidate : null;
}

/** `K7Q2XZ` as `K7Q 2XZ`, the way it is easiest to read across a table. */
export function spacedCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
