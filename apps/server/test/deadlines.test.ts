import { describe, expect, it } from "vitest";
import {
  ADJUDICATION_RETRY_MS,
  type Clock,
  LOBBY_TTL_MS,
  OUTBOX_CAP_MS,
  OUTBOX_MAX_ATTEMPTS,
  adjudicationRetryDelay,
  nextAlarmAt,
  outboxDelay,
  phaseSeconds,
  remainingMs,
} from "../src/deadlines.js";

const clock = (over: Partial<Clock>): Clock => ({
  status: "active",
  createdAt: 0,
  deadlineAt: null,
  retryAt: null,
  aiDueAt: null,
  pausedUntil: null,
  outboxAt: null,
  ...over,
});

describe("room clock", () => {
  it("uses the movement length for movement phases and the short length otherwise", () => {
    const durations = { movementSeconds: 600, shortPhaseSeconds: 300 };
    expect(phaseSeconds("S1901M", durations)).toBe(600);
    expect(phaseSeconds("F1901R", durations)).toBe(300);
    expect(phaseSeconds("W1901A", durations)).toBe(300);
  });

  it("wakes an active game at its deadline", () => {
    expect(nextAlarmAt(clock({ deadlineAt: 5_000 }))).toBe(5_000);
  });

  it("wakes earlier for a Claude seat that is running out of time", () => {
    expect(nextAlarmAt(clock({ deadlineAt: 600_000, aiDueAt: 90_000 }))).toBe(90_000);
  });

  it("wakes before the deadline to remind the players, but not while paused or retrying", () => {
    expect(nextAlarmAt(clock({ deadlineAt: 86_400_000, reminderAt: 82_800_000 }))).toBe(82_800_000);
    expect(nextAlarmAt(clock({ deadlineAt: 86_400_000, reminderAt: null }))).toBe(86_400_000);
    expect(nextAlarmAt(clock({ status: "paused", deadlineAt: null, pausedUntil: 42_000_000, reminderAt: 1_000 }))).toBe(42_000_000);
    expect(nextAlarmAt(clock({ deadlineAt: 1_000, retryAt: 6_000, reminderAt: 500 }))).toBe(6_000);
  });

  it("lets an adjudication retry replace the deadline it missed", () => {
    expect(nextAlarmAt(clock({ deadlineAt: 1_000, retryAt: 6_000 }))).toBe(6_000);
  });

  it("wakes a paused game only at its bounded timeout, never at the frozen deadline", () => {
    expect(nextAlarmAt(clock({ status: "paused", deadlineAt: null, pausedUntil: 42_000 }))).toBe(42_000);
    expect(nextAlarmAt(clock({ status: "paused", deadlineAt: 1_000, pausedUntil: 42_000 }))).toBe(42_000);
  });

  it("expires a lobby that never starts", () => {
    expect(nextAlarmAt(clock({ status: "lobby", createdAt: 10 }))).toBe(10 + LOBBY_TTL_MS);
  });

  it("keeps a finished room asleep unless the Registry hand-off is still owed", () => {
    expect(nextAlarmAt(clock({ status: "finished" }))).toBeNull();
    expect(nextAlarmAt(clock({ status: "finished", outboxAt: 9_000 }))).toBe(9_000);
    expect(nextAlarmAt(clock({ status: "abandoned", outboxAt: 9_000 }))).toBe(9_000);
  });

  it("banks the remaining time on pause and never a negative amount", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 14_000)).toBe(0);
    expect(remainingMs(null, 14_000)).toBe(0);
  });

  it("bounds adjudication retries", () => {
    expect(ADJUDICATION_RETRY_MS.map((_, i) => adjudicationRetryDelay(i + 1))).toEqual([...ADJUDICATION_RETRY_MS]);
    expect(adjudicationRetryDelay(ADJUDICATION_RETRY_MS.length + 1)).toBeNull();
  });

  it("backs the Registry hand-off off exponentially to a ceiling and then stops", () => {
    expect(outboxDelay(0)).toBe(5_000);
    expect(outboxDelay(1)).toBe(10_000);
    expect(outboxDelay(3)).toBe(40_000);
    expect(outboxDelay(15)).toBe(OUTBOX_CAP_MS);
    expect(outboxDelay(OUTBOX_MAX_ATTEMPTS - 1)).toBe(OUTBOX_CAP_MS);
    expect(outboxDelay(OUTBOX_MAX_ATTEMPTS)).toBeNull();
  });
});
