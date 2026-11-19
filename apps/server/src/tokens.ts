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

// ---------- players ----------

/** Player secrets are `cps_` and 48 hex characters (192 bits); a seat token always has two dots. */
const PLAYER_SECRET = /^cps_[0-9a-f]{48}$/;

export const mintPlayerSecret = () => `cps_${randomId(24)}`;
export const isPlayerSecret = (bearer: string) => PLAYER_SECRET.test(bearer);
export const mintPlayerId = () => `pl_${randomId(10)}`;

/** Crockford base32: no I, L, O or U, so a code read aloud or copied by hand survives. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A recovery code: `CABAL-` and five groups of four characters (100 bits). */
export function mintRecoveryCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => CROCKFORD[b & 31]).join("");
  return `CABAL-${body.match(/.{4}/g)!.join("-")}`;
}

/**
 * The 20 characters that identify a recovery code, however it was typed: case, spaces, dashes and
 * the `CABAL` prefix do not matter, and the letters people confuse with digits are read as digits.
 * Null when what is left cannot be a code.
 */
export function normaliseRecoveryCode(input: string): string | null {
  let body = input.toUpperCase().replace(/[\s-]/g, "");
  if (body.startsWith("CABAL")) body = body.slice(5);
  body = body.replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(body) ? body : null;
}

/** Recovery codes are hashed under their own prefix, so no other secret can ever collide with one. */
export const hashRecoveryCode = (body: string) => hashToken(`recovery:${body}`);
