export const ADJUDICATION_RETRY_MS = 60_000;

export function recoverSchedule(
  status: "active" | "paused",
  pauseReason: string | null | undefined,
  phase: string,
  deadlineAt: number | null,
  durations: { movementSeconds: number; shortPhaseSeconds: number; graceSeconds: number },
  now: number,
): { deadlineAt: number | null; alarmAt: number | null } {
  if (status === "paused") {
    return pauseReason === "adjudication_failed"
      ? { deadlineAt: null, alarmAt: now + ADJUDICATION_RETRY_MS }
      : { deadlineAt: null, alarmAt: null };
  }
  const seconds = phase.endsWith("M") ? durations.movementSeconds : durations.shortPhaseSeconds;
  const restoredDeadline = deadlineAt ?? now + (seconds + durations.graceSeconds) * 1000;
  return { deadlineAt: restoredDeadline, alarmAt: Math.max(now, restoredDeadline) };
}
