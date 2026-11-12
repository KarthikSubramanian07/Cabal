import { describe, expect, it } from "vitest";
import { ADJUDICATION_RETRY_MS, recoverSchedule } from "../src/deadlines.js";

const durations = { movementSeconds: 600, shortPhaseSeconds: 300, graceSeconds: 45 };

describe("recoverSchedule", () => {
  it("rebuilds a missing movement deadline from its pacing duration and grace", () => {
    expect(recoverSchedule("active", null, "S1901M", null, durations, 1_000)).toEqual({
      deadlineAt: 646_000,
      alarmAt: 646_000,
    });
  });

  it("repairs an overdue alarm to run immediately without changing the saved deadline", () => {
    expect(recoverSchedule("active", null, "W1901A", 10_000, durations, 20_000)).toEqual({
      deadlineAt: 10_000,
      alarmAt: 20_000,
    });
  });

  it("retries failed adjudication but leaves absence-paused games unscheduled", () => {
    expect(recoverSchedule("paused", "adjudication_failed", "S1901M", null, durations, 4_000)).toEqual({
      deadlineAt: null,
      alarmAt: 4_000 + ADJUDICATION_RETRY_MS,
    });
    expect(recoverSchedule("paused", "humans_absent", "S1901M", null, durations, 4_000)).toEqual({
      deadlineAt: null,
      alarmAt: null,
    });
  });
});
