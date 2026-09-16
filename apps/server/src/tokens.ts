/**
 * Seat tokens: `<gameId>.<POWER>.<random>`. The room stores only a SHA-256 of
 * the token, so a leaked database never yields a usable credential.
 */

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Six character, unambiguous game code. */
export function gameCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

export function mintToken(gameId: string, power: string): string {
  return `${gameId}.${power}.${randomId(24)}`;
}

export function parseToken(token: string): { gameId: string; power: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [gameId, power, secret] = parts;
  if (!gameId || !power || !secret || secret.length < 32) return null;
  return { gameId, power };
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
