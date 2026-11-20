/**
 * A player's record in words and figures: the rating's path through their recent games, how
 * dependably they order, and their trust ledger. Pure, so each rule is unit tested.
 */
import type { MyGame, PlayerResult, PowerName, RatingHistoryResponse, ReliabilityView, TrustView } from "@cabal/protocol";

export interface RatingPoint {
  /** The rating after this game (or, for the first point, before the first game shown). */
  rating: number;
  /** Its deviation then: the rating is likely within two of these either side. */
  rd: number;
  /** What the game did to it; null for the starting point. */
  delta: number | null;
  /** The game that moved it; null for the starting point. */
  game: { gameId: string; power: PowerName | null; finishedAt: number } | null;
}

/**
 * The rating's path, oldest first, from the server's rating history: where it stood before the
 * oldest game listed, then after each rated game, with the deviation it had at each point. The
 * figures are the ones the server stored when each game was rated, never worked back.
 */
export function ratingPath(history: Pick<RatingHistoryResponse, "points"> | null): RatingPoint[] {
  const points = history?.points ?? [];
  if (points.length === 0) return [];
  const first = points[0]!;
  return [
    { rating: first.ratingBefore, rd: first.rdBefore, delta: null, game: null },
    ...points.map((p) => ({
      rating: p.ratingAfter,
      rd: p.rdAfter,
      delta: p.ratingAfter - p.ratingBefore,
      game: { gameId: p.gameId, power: p.power, finishedAt: p.at },
    })),
  ];
}

/** The range a rating is likely within: two deviations either side, rounded for reading. */
export function ratingRange(p: Pick<RatingPoint, "rating" | "rd">): [number, number] {
  return [Math.round(p.rating - 2 * p.rd), Math.round(p.rating + 2 * p.rd)];
}

/** Round ticks covering [min, max]: three or four of them, on steps of 5, 10, 25, 50 or 100. */
export function ratingTicks(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 20) {
    const mid = (hi + lo) / 2;
    lo = mid - 10;
    hi = mid + 10;
  }
  const span = hi - lo;
  const step = [5, 10, 25, 50, 100, 250].find((s) => span / s <= 3) ?? 500;
  const first = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let t = first; t <= hi + step - 1e-9; t += step) out.push(t);
  return out;
}

export function signed(n: number, digits = 0): string {
  const v = Number(n.toFixed(digits));
  return v > 0 ? `+${v.toFixed(digits)}` : v < 0 ? `−${Math.abs(v).toFixed(digits)}` : (0).toFixed(digits);
}

export function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Reliability as one sentence. */
export function reliabilityLine(r: ReliabilityView): string {
  if (r.phasesDue === 0) return "No phases ordered yet. Every newcomer starts at 90%.";
  const parts = [`Ordered on time in ${r.phasesOnTime} of ${r.phasesDue} phases`];
  if (r.phasesLate) parts.push(`late in ${r.phasesLate}`);
  if (r.missed) parts.push(`missed ${r.missed}`);
  const games = r.gamesCompleted + r.gamesWalkedOut;
  const tail = games ? ` Finished ${r.gamesCompleted} of ${games} ${games === 1 ? "game" : "games"}.` : "";
  return `${parts.join(", ")}.${tail}`;
}

/** The trust ledger as one sentence. */
export function trustLine(t: TrustView): string {
  const made = t.kept + t.broken;
  if (made === 0 && t.void === 0) return "No promises on the record yet. Everyone starts at 50%.";
  const kept = `Kept ${t.kept} of ${made} ${made === 1 ? "promise" : "promises"}`;
  return t.void ? `${kept}; ${t.void} came to nothing.` : `${kept}.`;
}

export function resultWord(g: Pick<PlayerResult, "result" | "score" | "walkedOut">): string {
  if (g.walkedOut) return "Left";
  if (g.result === "solo") return g.score > 0 ? "Won" : "Lost";
  if (g.result === "draw") return g.score > 0 ? "Drew" : "Lost";
  return "Abandoned";
}

/**
 * The public record hides an unlisted game's code from everyone; its own player may see it. Fill
 * the codes in from the player's own list of games, matched by seat and the moment it ended.
 */
export function withOwnCodes(recent: readonly PlayerResult[], mine: readonly MyGame[]): PlayerResult[] {
  return recent.map((g) => {
    if (g.gameId) return g;
    const own = mine.find((m) => m.power === g.power && m.finishedAt === g.finishedAt);
    return own ? { ...g, gameId: own.gameId } : g;
  });
}

/** A table on the player's own list, in a word or two. */
export function tableState(g: Pick<MyGame, "status" | "result" | "score">): string {
  if (g.status === "playing") return "In play";
  if (g.status === "left") return "Seat handed on";
  if (g.status === "abandoned") {
    // A game that ended before any phase resolved (a draw voted at once) is kept as void: it
    // happened, but it counts for nothing.
    return g.result === "draw" ? "Drawn before play" : g.result === "solo" ? "Ended before play" : "Abandoned";
  }
  return g.result === "solo" ? (g.score ? "Won" : "Lost") : "Drawn";
}

/**
 * Games a player finished that the public list leaves out: those at friendly tables (unlisted,
 * Play now). The list holds the latest `shown` at most, so only a short list can say how many.
 */
export function friendlyGames(played: number, listed: number, cap = 20): number {
  return listed < cap ? Math.max(0, played - listed) : 0;
}
