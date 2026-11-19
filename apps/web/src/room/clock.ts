/**
 * The phase clock. Every countdown is measured against the server's clock (the offset each
 * welcome, state and deadline frame carries), never this device's, so two players looking at
 * the same table read the same time.
 */

/** Time left, as a clock face: `9:41`, `1:02:05`, or `2 days 4 h` when it is far off. */
export function clockFace(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days >= 1) return hours ? `${days} ${days === 1 ? "day" : "days"} ${hours} h` : `${days} ${days === 1 ? "day" : "days"}`;
  const ss = String(seconds).padStart(2, "0");
  if (hours >= 1) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** How urgent the clock is: calm, under five minutes, under one minute. */
export function urgency(ms: number): "calm" | "soon" | "now" {
  if (ms <= 60_000) return "now";
  if (ms <= 5 * 60_000) return "soon";
  return "calm";
}

/** The clock in words, for a screen reader's occasional announcement. */
export function clockWords(ms: number): string {
  if (ms <= 0) return "The deadline has passed.";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left.`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `About ${hours} ${hours === 1 ? "hour" : "hours"} left.`;
  return `About ${Math.round(hours / 24)} days left.`;
}
