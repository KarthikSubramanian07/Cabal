/**
 * Seat tokens: `<gameId>.<POWER>.<random>`. The room stores only a SHA-256 of
 * the token, so a leaked database never yields a usable credential.
 */
import { createHash, timingSafeEqual } from "node:crypto";

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

/**
 * Synchronous on purpose: a room picks a seat and writes its token hash in one uninterrupted step,
 * so two joins can never interleave between the choice and the write.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compare two hex digests without leaking where they differ. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
