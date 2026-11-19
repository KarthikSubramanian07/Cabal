/**
 * Ratings, reliability and trust: pure functions, no I/O. The index (d1-index.ts) feeds them a
 * finished game and the players' current ratings, and writes back what they return.
 *
 * Skill is weighted pairwise Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013). A
 * seven-player game is decomposed into pairings between the rated players at the table, each
 * scored from the two players' shares of the result, and each weighted `min(1, 2 / (N - 1))` (the
 * diplicity weighting): one game moves a rating about as much as two head-to-head games, not six,
 * so a single table cannot collapse a newcomer's deviation. One game is one rating period. See
 * docs/adr/0011-weighted-pairwise-glicko-2.md for why, and for the rules of a rated game.
 *
 * Reliability and trust are separate visible numbers, never folded into skill.
 */
import type { GamePlayerRecord, GameRecord } from "@cabal/protocol";

/** The only ladder for now. Stored per row so variants or press modes can get their own later. */
export const LADDER = "overall";

export const GLICKO = {
  /** A newcomer: 1500, deviation 350, volatility 0.06. */
  rating: 1500,
  rd: 350,
  volatility: 0.06,
  /** System constant: how much volatility may change in one period. Glickman suggests 0.3 to 1.2. */
  tau: 0.5,
  /** Converts between the Glicko scale and the Glicko-2 scale. */
  scale: 173.7178,
  /** A deviation never grows past a newcomer's, however long a player is away. */
  maxRd: 350,
  /** Inactivity grows the deviation by one rating period of volatility per this much time. */
  periodMs: 30 * 24 * 3600_000,
} as const;

/** Who counts as a rated game and who is on the leaderboard. */
export const RATING_RULES = {
  /** Distinct signed-in players who held a seat. Fewer, and the game counts for nothing but conduct. */
  minPlayers: 3,
  /** Two full game years (four movement phases) before a game is rated, so a draw cannot be farmed. */
  minMovementPhases: 4,
  /**
   * On the leaderboard: at least this many rated games and a deviation no wider than this. The
   * board orders by `rating - 2 * rd`, so an uncertain rating already ranks low on its own; the
   * floor only keeps off players the system knows next to nothing about. (A loser of a solo is
   * paired only with the winner, so deviations fall slowly; 150 would take a dozen games.)
   */
  establishedGames: 3,
  establishedRd: 200,
} as const;

/** Bayesian priors: a newcomer starts at 90 percent reliable and 50 percent trusted. */
export const RELIABILITY_PRIOR = { onTime: 9, due: 10, lateCredit: 0.5, walkoutPenalty: 4 } as const;
export const TRUST_PRIOR = { kept: 5, total: 10 } as const;

export interface Rating {
  rating: number;
  rd: number;
  volatility: number;
}

export const NEWCOMER: Rating = { rating: GLICKO.rating, rd: GLICKO.rd, volatility: GLICKO.volatility };

/** One opponent in a rating period: their rating, the score against them (0 to 1) and its weight. */
export interface Opponent {
  rating: number;
  rd: number;
  score: number;
  weight: number;
}

export interface Update extends Rating {
  /** Per opponent, in the order given: expected score and the rating points it moved. */
  contributions: { expected: number; delta: number }[];
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/**
 * One Glicko-2 rating period for one player, with weighted results. With every weight 1 this is
 * Glickman's algorithm exactly. A period with no opponents only grows the deviation.
 */
export function glicko2(player: Rating, opponents: Opponent[], tau: number = GLICKO.tau): Update {
  const mu = (player.rating - GLICKO.rating) / GLICKO.scale;
  const phi = player.rd / GLICKO.scale;
  const sigma = player.volatility;
  const games = opponents.filter((o) => o.weight > 0);
  if (games.length === 0) {
    const grown = Math.min(Math.sqrt(phi * phi + sigma * sigma), GLICKO.maxRd / GLICKO.scale);
    return { rating: player.rating, rd: grown * GLICKO.scale, volatility: sigma, contributions: opponents.map(() => ({ expected: 0, delta: 0 })) };
  }
  const terms = opponents.map((o) => {
    const muJ = (o.rating - GLICKO.rating) / GLICKO.scale;
    const gJ = g(o.rd / GLICKO.scale);
    const expected = 1 / (1 + Math.exp(-gJ * (mu - muJ)));
    return { gJ, expected, score: o.score, weight: Math.max(0, o.weight) };
  });
  let vInverse = 0;
  let sum = 0;
  for (const t of terms) {
    vInverse += t.weight * t.gJ * t.gJ * t.expected * (1 - t.expected);
    sum += t.weight * t.gJ * (t.score - t.expected);
  }
  const v = 1 / vInverse;
  const delta = v * sum;

  // New volatility: the root of f by the Illinois algorithm (step 5 of the paper).
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const step = phiNew * phiNew;
  const contributions = terms.map((t) => ({ expected: t.expected, delta: step * t.weight * t.gJ * (t.score - t.expected) * GLICKO.scale }));
  const muNew = mu + step * sum;
  return {
    rating: muNew * GLICKO.scale + GLICKO.rating,
    rd: Math.min(phiNew * GLICKO.scale, GLICKO.maxRd),
    volatility: sigmaNew,
    contributions,
  };
}

/** A deviation grown for the time since the player's last rated game (Glicko-2 step 6, lazily). */
export function decayed(rating: Rating, lastGameAt: number, now: number): Rating {
  const periods = Math.max(0, (now - lastGameAt) / GLICKO.periodMs);
  if (periods === 0) return rating;
  const phi = rating.rd / GLICKO.scale;
  const grown = Math.sqrt(phi * phi + periods * rating.volatility * rating.volatility) * GLICKO.scale;
  return { ...rating, rd: Math.min(grown, GLICKO.maxRd) };
}

export const conservative = (r: Rating) => r.rating - 2 * r.rd;

export function established(r: Rating & { games: number }): boolean {
  return r.games >= RATING_RULES.establishedGames && r.rd <= RATING_RULES.establishedRd;
}

// ---------- which games are rated, and who plays whom ----------

/** A stint that takes part in the rating: a signed-in human. */
export interface Participant {
  playerId: string;
  power: string;
  /** This stint's share of the result: the power's score if the stint lasted to the end, else 0. */
  score: number;
  /** Took the seat over mid-game: such a player can only gain from the game. */
  substitute: boolean;
}

export interface RatedGame {
  rated: boolean;
  /** Why not, when not: `not_public`, `not_decided`, `too_short`, `too_few_players`. */
  reason: string | null;
  participants: Participant[];
}

/**
 * The rules of a rated game, in one place:
 *
 *  - the game was public (unlisted games between friends are friendly games),
 *  - it ended in a solo or a draw (an abandoned game has no result to learn from),
 *  - it lasted two full game years,
 *  - at least three distinct signed-in players held seats in it.
 *
 * AI seats and anonymous seats are never rated and are not opponents: only pairings between two
 * signed-in humans exist. A bot is deterministic and beatable, so rating against it would let a
 * patient player farm points; and an anonymous seat has no rating to compare with.
 *
 * A player who left their seat (a substitute took over) takes a share of 0, a loss against every
 * player with a share. A substitute is rated on the seat's result but can only gain.
 */
export function ratedGame(record: GameRecord): RatedGame {
  const players = (record.players ?? []).filter((p): p is GamePlayerRecord & { playerId: string } => p.kind === "human" && p.playerId !== null);
  const participants: Participant[] = players.map((p) => ({
    playerId: p.playerId,
    power: p.power,
    score: p.leftReason === null ? (record.scores[p.power] ?? 0) : 0,
    substitute: p.substitute,
  }));
  const distinct = new Set(participants.map((p) => p.playerId));
  const reason =
    record.settings.visibility !== "public"
      ? "not_public"
      : record.result === "abandoned"
        ? "not_decided"
        : (record.movementPhases ?? 0) < RATING_RULES.minMovementPhases
          ? "too_short"
          : distinct.size < RATING_RULES.minPlayers || distinct.size !== participants.length
            ? "too_few_players"
            : null;
  return { rated: reason === null, reason, participants };
}

/**
 * The pairings one participant is rated on: every other participant, scored `a / (a + b)` from the
 * two shares. A solo winner beats everyone; draw members split evenly under Draw Size and by
 * centres under Sum of Squares, and beat everyone outside the draw. Two players who both scored 0
 * are not paired: the game says nothing about which of them was better.
 */
export function pairings(participants: Participant[], index: number): { opponent: number; score: number }[] {
  const me = participants[index]!;
  const out: { opponent: number; score: number }[] = [];
  participants.forEach((other, j) => {
    if (j === index) return;
    const total = me.score + other.score;
    if (total <= 0) return;
    out.push({ opponent: j, score: me.score / total });
  });
  return out;
}

/** `min(1, 2 / (N - 1))`: a full table is worth about two head-to-head games. */
export const pairWeight = (n: number) => (n <= 1 ? 0 : Math.min(1, 2 / (n - 1)));

export interface GameRatingChange {
  playerId: string;
  before: Rating;
  after: Rating;
  opponents: { playerId: string; score: number; expected: number; delta: number }[];
}

/**
 * Rate one game. `current` holds each participant's rating as of the game's end (decay already
 * applied); a missing entry is a newcomer. Everyone is rated against the ratings from before the
 * game, so the order of the table never matters.
 */
export function rateGame(participants: Participant[], current: Map<string, Rating>): GameRatingChange[] {
  const weight = pairWeight(participants.length);
  const before = participants.map((p) => current.get(p.playerId) ?? NEWCOMER);
  return participants.map((p, i) => {
    const pairs = pairings(participants, i);
    const update = glicko2(
      before[i]!,
      pairs.map((pair) => ({ rating: before[pair.opponent]!.rating, rd: before[pair.opponent]!.rd, score: pair.score, weight })),
    );
    let after: Rating = { rating: update.rating, rd: update.rd, volatility: update.volatility };
    let contributions = update.contributions;
    // A substitute who took over a losing position must never be punished for it.
    if (p.substitute && after.rating < before[i]!.rating) {
      after = { ...after, rating: before[i]!.rating };
      contributions = contributions.map((c) => ({ ...c, delta: 0 }));
    }
    return {
      playerId: p.playerId,
      before: before[i]!,
      after,
      opponents: pairs.map((pair, k) => ({
        playerId: participants[pair.opponent]!.playerId,
        score: pair.score,
        expected: contributions[k]!.expected,
        delta: contributions[k]!.delta,
      })),
    };
  });
}

// ---------- reliability and trust ----------

export function reliability(stats: { phasesDue: number; phasesOnTime: number; phasesLate: number; gamesWalkedOut: number }): number {
  const p = RELIABILITY_PRIOR;
  const score = (stats.phasesOnTime + p.lateCredit * stats.phasesLate + p.onTime) / (stats.phasesDue + p.due + p.walkoutPenalty * stats.gamesWalkedOut);
  return Math.max(0, Math.min(1, score));
}

export function trust(stats: { kept: number; broken: number }): number {
  return (stats.kept + TRUST_PRIOR.kept) / (stats.kept + stats.broken + TRUST_PRIOR.total);
}

/** The same two formulas as SQL over `player_stats`-shaped sums, so one statement can recompute them. */
export const RELIABILITY_SQL = (onTime: string, late: string, due: string, walkedOut: string) => {
  const p = RELIABILITY_PRIOR;
  return `MAX(0.0, MIN(1.0, (${onTime} + ${p.lateCredit} * ${late} + ${p.onTime}.0) / (${due} + ${p.due}.0 + ${p.walkoutPenalty}.0 * ${walkedOut})))`;
};
export const TRUST_SQL = (kept: string, broken: string) => `((${kept} + ${TRUST_PRIOR.kept}.0) / (${kept} + ${broken} + ${TRUST_PRIOR.total}.0))`;

/**
 * Does a finished game count towards its players' trust ledgers? The same bar as a rated game
 * (`ratedGame`): public, decided by a solo or a draw, two full game years, three distinct signed-in
 * players. One rule decides what a real game is, so two free accounts in an unlisted game, a game
 * voted to a draw after one phase or an abandoned one cannot fill a ledger with promises they
 * arranged to keep. The game's own ledger of receipts is kept whatever this says.
 */
export const countsForTrust = (record: GameRecord): boolean => ratedGame(record).rated;

/**
 * Does a pledge count towards the pledger's trust ledger? Only a promise made to another person
 * can be kept or broken in a way that says something: to a power a different signed-in player held
 * when it was made, or to the whole table when at least two signed-in players sat at it. Pledges to
 * bots, to anonymous seats, or to oneself are part of the game's ledger but not of the player's.
 */
export function countsForLedger(pledge: { pledgerPlayer: string | null; audience: string; audiencePlayer: string | null }, distinctPlayers: number): boolean {
  if (pledge.pledgerPlayer === null) return false;
  if (pledge.audience === "ALL") return distinctPlayers >= 2;
  return pledge.audiencePlayer !== null && pledge.audiencePlayer !== pledge.pledgerPlayer;
}

export interface LedgerPledge {
  phase: string;
  audience: string;
  receipt: "kept" | "broken" | "void";
  pledgerPlayer: string | null;
  audiencePlayer: string | null;
}

/**
 * One stint's receipts for its player's trust ledger: the pledges that count (`countsForLedger`),
 * at most one receipt per audience per phase. Sixty promises to one power in one phase are one
 * promise: broken if any of them was broken, else kept if any was kept, else void.
 */
export function ledgerTally(pledges: readonly LedgerPledge[], distinctPlayers: number): { kept: number; broken: number; void: number } {
  const byPromise = new Map<string, LedgerPledge["receipt"]>();
  const rank = { void: 0, kept: 1, broken: 2 } as const;
  for (const p of pledges) {
    if (!countsForLedger(p, distinctPlayers)) continue;
    const key = `${p.phase} ${p.audience}`;
    const was = byPromise.get(key);
    if (was === undefined || rank[p.receipt] > rank[was]) byPromise.set(key, p.receipt);
  }
  const out = { kept: 0, broken: 0, void: 0 };
  for (const receipt of byPromise.values()) out[receipt] += 1;
  return out;
}
