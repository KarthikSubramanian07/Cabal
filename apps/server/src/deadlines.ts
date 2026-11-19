/**
 * Clock arithmetic for a GameRoom, kept pure so it can be tested without a Durable Object.
 *
 * A room owns exactly one alarm, but several things want waking: the phase deadline, a bounded
 * pause, an AI turn that is taking too long, an adjudication retry, a lobby that never started and
 * the Registry hand-off. `nextAlarmAt` folds them into the single earliest instant.
 */

/** Adjudication failures retry on this schedule and then fall back to holding every unit. */
export const ADJUDICATION_RETRY_MS = [5_000, 15_000, 45_000] as const;

/** A paused live game resumes by itself after this long, with the clock it had left. */
export const PAUSE_LIMIT_MS = 10 * 60_000;

/** A Claude seat that has not answered by then is played by the bot orders already on file. */
export const AI_TURN_LIMIT_MS = 90_000;

/** A lobby nobody starts is closed after a week. */
export const LOBBY_TTL_MS = 7 * 24 * 3600_000;

/** Registry hand-off: 5 s doubling to a one hour ceiling, for at most this many attempts. */
export const OUTBOX_BASE_MS = 5_000;
export const OUTBOX_CAP_MS = 3_600_000;
export const OUTBOX_MAX_ATTEMPTS = 40;

/** Delay before retry number `attempt` (1 based), or null once the retries are spent. */
export function adjudicationRetryDelay(attempt: number): number | null {
  return ADJUDICATION_RETRY_MS[attempt - 1] ?? null;
}

/** Capped exponential backoff for the Registry hand-off; null when it should stop trying. */
export function outboxDelay(attempts: number): number | null {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return null;
  return Math.min(OUTBOX_CAP_MS, OUTBOX_BASE_MS * 2 ** Math.min(attempts, 20));
}

export function phaseSeconds(phase: string, durations: { movementSeconds: number; shortPhaseSeconds: number }): number {
  return phase.endsWith("M") ? durations.movementSeconds : durations.shortPhaseSeconds;
}

export interface Clock {
  status: "lobby" | "active" | "paused" | "finished" | "abandoned";
  createdAt: number;
  deadlineAt: number | null;
  /** Set while an adjudication failure is being retried. */
  retryAt: number | null;
  /** Set while Claude seats are still thinking. */
  aiDueAt: number | null;
  /** Set while paused. */
  pausedUntil: number | null;
  /** Next Registry hand-off attempt, in any status. */
  outboxAt: number | null;
}

/** The earliest instant this room needs to wake, or null when nothing is pending. */
export function nextAlarmAt(clock: Clock): number | null {
  const due: number[] = [];
  if (clock.outboxAt !== null) due.push(clock.outboxAt);
  if (clock.status === "lobby") due.push(clock.createdAt + LOBBY_TTL_MS);
  if (clock.status === "paused" && clock.pausedUntil !== null) due.push(clock.pausedUntil);
  if (clock.status === "active") {
    if (clock.retryAt !== null) due.push(clock.retryAt);
    else if (clock.deadlineAt !== null) due.push(clock.deadlineAt);
    if (clock.aiDueAt !== null) due.push(clock.aiDueAt);
  }
  return due.length === 0 ? null : Math.min(...due);
}

/** Remaining phase time to bank when a game pauses. Never negative. */
export function remainingMs(deadlineAt: number | null, now: number): number {
  return deadlineAt === null ? 0 : Math.max(0, deadlineAt - now);
}
