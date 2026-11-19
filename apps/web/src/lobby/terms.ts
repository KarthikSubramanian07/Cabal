/**
 * A game's settings in words. The lobby shows them as the terms of the table, the create
 * dialog describes each choice with them, and the games list summarises with them, so one
 * setting is always called the same thing.
 */
import type { GameSettings, Pacing, PowerName, PressMode, Scoring } from "@cabal/protocol";

export const POWERS: readonly PowerName[] = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"];

export function powerLabel(power: string): string {
  return power.charAt(0) + power.slice(1).toLowerCase();
}

/** `600` as `10 minutes`, `86400` as `1 day`, `172800` as `2 days`. */
export function duration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  if (seconds >= 3_600) return `${Math.round((seconds / 3_600) * 10) / 10} hours`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} minutes`;
  return `${seconds} seconds`;
}

export const PACING: Record<Pacing, { label: string; blurb: string }> = {
  live: { label: "Live", blurb: "Everyone at the table now. Ten minutes to move." },
  daily: { label: "Daily", blurb: "A move a day, for a game over a week or two." },
  async: { label: "Relaxed", blurb: "Two days a move, for players in different time zones." },
};

export const PRESS: Record<PressMode, { label: string; blurb: string }> = {
  full: { label: "Full press", blurb: "Private messages between any two powers, and the public table." },
  public: { label: "Public press", blurb: "Only messages the whole table can read." },
  gunboat: { label: "Gunboat", blurb: "No messages at all. Orders do the talking." },
};

export const RULEBOOK: Record<GameSettings["rulebook"], { label: string; blurb: string }> = {
  "2023": { label: "2023 rules", blurb: "The current rulebook, and the one most players know." },
  "1982": { label: "1982 rules", blurb: "The 1982 rulebook." },
  "1971": { label: "1971 rules", blurb: "Any fleet ordered to convoy makes the move a convoy." },
  dptg: { label: "DPTG rules", blurb: "A move goes by convoy only when it says via convoy." },
};

export const SCORING: Record<Scoring, { label: string; blurb: string }> = {
  sos: { label: "Sum of squares", blurb: "A draw is shared by supply centres squared: the bigger power takes more." },
  dss: { label: "Draw size", blurb: "A draw is shared equally among everyone in it." },
};

export interface Term {
  name: string;
  value: string;
}

/** The terms of a table, in the order a player reads them. */
export function describeTerms(s: GameSettings, started = false): Term[] {
  const brain = s.aiBrain === "claude" ? "Claude" : "the bot";
  return [
    { name: "Pacing", value: `${PACING[s.pacing].label}, ${duration(s.movementSeconds)} to move` },
    { name: "Press", value: PRESS[s.press].label },
    { name: "Rules", value: RULEBOOK[s.rulebook].label },
    { name: "Draws", value: s.dias ? "Include all survivors" : "May name who shares" },
    { name: "Scoring", value: SCORING[s.scoring].label },
    { name: "Empty seats", value: s.aiFill ? (started ? `Played by ${brain}` : `Played by ${brain} when the game starts`) : "Wait for players" },
    { name: "Listing", value: s.visibility === "public" ? "Listed in the games room" : "Only by code or link" },
  ];
}

/** One line for a games list row. */
export function shortTerms(s: GameSettings): string {
  return `${PACING[s.pacing].label}, ${PRESS[s.press].label.toLowerCase()}, ${RULEBOOK[s.rulebook].label}`;
}

/** `S1901M` as `Spring 1901, movement`. */
export function phaseLabel(phase: string): string {
  if (phase === "COMPLETED") return "Game over";
  const m = /^([SFW])(\d{4})([MRA])$/.exec(phase);
  if (!m) return phase;
  const season = m[1] === "S" ? "Spring" : m[1] === "F" ? "Fall" : "Winter";
  const kind = m[3] === "M" ? "movement" : m[3] === "R" ? "retreats" : "adjustments";
  return `${season} ${m[2]}, ${kind}`;
}

/** Time left until `deadlineAt`, said briefly: `4 min`, `3 h 20 min`, `2 days`. */
export function timeLeft(deadlineAt: number, now: number): string {
  const ms = deadlineAt - now;
  if (ms <= 0) return "due now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

/** How long ago, briefly: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
