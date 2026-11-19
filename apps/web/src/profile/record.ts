/**
 * A player's record in words and figures: the rating's path through their recent games, how
 * dependably they order, and their trust ledger. Pure, so each rule is unit tested.
 */
import type { MyGame, PlayerProfile, PlayerResult, ReliabilityView, TrustView } from "@cabal/protocol";

export interface RatingPoint {
  /** The rating after this game (or, for the first point, before the first game shown). */
  rating: number;
  /** What the game did to it; null for the starting point. */
  delta: number | null;
  /** The game that moved it; null for the starting point. */
  game: PlayerResult | null;
}

/**
 * The rating's path, oldest first, worked back from today's rating through the rating change
 * of each rated game on the record. The profile carries the most recent games only, so the path
 * starts where the oldest of those began.
 */
export function ratingPath(profile: Pick<PlayerProfile, "rating" | "recent">): RatingPoint[] {
  if (!profile.rating) return [];
  const rated = profile.recent.filter((g) => g.ratingDelta !== null);
  if (rated.length === 0) return [];
  const points: RatingPoint[] = [];
  let r = profile.rating.rating;
  for (const game of rated) {
    points.push({ rating: r, delta: game.ratingDelta, game });
    r -= game.ratingDelta!;
  }
  points.push({ rating: r, delta: null, game: null });
  return points.reverse();
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
