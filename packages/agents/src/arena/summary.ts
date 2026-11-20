/**
 * What an arena game measured, and the gates a nightly run holds it to.
 *
 * Every number comes from two sources only: the decisions log (what each seat proposed, what was
 * dropped, what it cost) and the phase log (what was submitted, adjudicated and receipted). The
 * same summary therefore describes a bot game and a Claude game, and a change to a prompt can be
 * judged by the difference.
 */
import { verifySaved } from "@cabal/engine";
import { type Usage, ZERO_USAGE, addUsage, microsToUsd } from "../cost.js";
import { outgoingPress } from "../press.js";
import { phaseKind } from "../prompt.js";
import type { ArenaGame } from "./local.js";

export interface SeatSummary {
  power: string;
  /** The brains that answered for this seat, by name, with how many decisions each. */
  brains: Record<string, number>;
  decisions: number;
  /** Orders the seat wrote in final-order steps, before validation. */
  proposed: number;
  /** Of those, orders that were not on the legal menu (the model's illegal-order rate). */
  offMenu: number;
  /** Of those, every order validation set aside (off-menu, a second order for a unit, over the allowance). */
  dropped: number;
  /** Units ordered to hold or left without an order in movement phases, and units in those phases. */
  holds: number;
  movementUnits: number;
  fallbacks: number;
  failovers: number;
  messages: number;
  pledges: { made: number; kept: number; broken: number; void: number };
  costMicros: number;
  usage: Usage;
  /** Supply centres at the end of each year played, in the order of `years`. */
  centres: number[];
}

export interface ArenaSummary {
  gameId: string;
  status: string;
  phases: number;
  lastPhase: string | null;
  years: number[];
  seats: SeatSummary[];
  totals: {
    decisions: number;
    proposed: number;
    offMenu: number;
    /** `offMenu / proposed`: the issue's illegal-order rate, measured before validation. */
    offMenuRate: number;
    dropped: number;
    /** Orders the engine adjudicated as illegal or refused outright. Zero by construction, and checked. */
    illegalSubmitted: number;
    holdRate: number;
    fallbacks: number;
    failovers: number;
    messages: number;
    pledges: { made: number; kept: number; broken: number; void: number };
    /** `kept / (kept + broken)`, or null when no pledge was judged. */
    honesty: number | null;
    costMicros: number;
    costUsd: number;
    usage: Usage;
  };
  /** Ways the saved game failed to replay through `verifySaved`: must be zero. */
  divergences: number;
  elapsedMs: number;
}

export function summarise(game: ArenaGame): ArenaSummary {
  const powers = [...new Set([...game.phases.flatMap((p) => Object.keys(p.centres)), ...game.records.map((r) => r.power)])].sort();
  // The last phase of each year: centres are read off it.
  const yearEnds = new Map<number, number>();
  game.phases.forEach((p, i) => {
    const y = Number(/\d{4}/.exec(p.phase)?.[0]);
    if (Number.isFinite(y)) yearEnds.set(y, i);
  });
  const years = [...yearEnds.keys()].sort((a, b) => a - b);
  const seat = (power: string): SeatSummary => {
    const mine = game.records.filter((r) => r.power === power);
    const finals = mine.filter((r) => r.step === "order");
    const brains: Record<string, number> = {};
    for (const r of mine) {
      const name = r.model ?? "unmetered";
      brains[name] = (brains[name] ?? 0) + 1;
    }
    let holds = 0;
    let movementUnits = 0;
    for (const p of game.phases) {
      if (phaseKind(p.phase) !== "M") continue;
      const units = p.units[power] ?? 0;
      const orders = p.submitted[power] ?? [];
      movementUnits += units;
      holds += orders.filter((o) => o.endsWith(" H")).length + Math.max(0, units - orders.length);
    }
    const pledges = { made: 0, kept: 0, broken: 0, void: 0 };
    for (const p of game.phases) {
      for (const r of p.pledges) {
        if (r.pledger !== power) continue;
        pledges.made++;
        pledges[r.receipt]++;
      }
    }
    return {
      power,
      brains,
      decisions: mine.length,
      proposed: finals.reduce((n, r) => n + r.decision.orders.length, 0),
      offMenu: finals.reduce((n, r) => n + r.dropped.filter((d) => d.reason === "not on the legal menu").length, 0),
      dropped: finals.reduce((n, r) => n + r.dropped.length, 0),
      holds,
      movementUnits,
      fallbacks: mine.filter((r) => r.fallback).length,
      failovers: mine.filter((r) => r.failover !== null).length,
      messages: mine.reduce((n, r) => n + outgoingPress({ decision: r.decision, validated: { orders: r.orders, dropped: r.dropped } }, power, "full").length, 0),
      pledges,
      costMicros: mine.reduce((n, r) => n + r.costMicros, 0),
      usage: mine.reduce((u, r) => (r.usage ? addUsage(u, r.usage) : u), ZERO_USAGE),
      centres: years.map((y) => game.phases[yearEnds.get(y)!]!.centres[power] ?? 0),
    };
  };
  const seats = powers.map(seat);
  const sum = (f: (s: SeatSummary) => number) => seats.reduce((n, s) => n + f(s), 0);
  const pledges = {
    made: sum((s) => s.pledges.made),
    kept: sum((s) => s.pledges.kept),
    broken: sum((s) => s.pledges.broken),
    void: sum((s) => s.pledges.void),
  };
  const proposed = sum((s) => s.proposed);
  const costMicros = sum((s) => s.costMicros);
  let divergences: number;
  try {
    divergences = verifySaved(game.saved).divergences.length;
  } catch {
    divergences = Number.POSITIVE_INFINITY;
  }
  return {
    gameId: game.gameId,
    status: game.status,
    phases: game.phases.length,
    lastPhase: game.phases.at(-1)?.phase ?? null,
    years,
    seats,
    totals: {
      decisions: sum((s) => s.decisions),
      proposed,
      offMenu: sum((s) => s.offMenu),
      offMenuRate: proposed === 0 ? 0 : sum((s) => s.offMenu) / proposed,
      dropped: sum((s) => s.dropped),
      illegalSubmitted: game.phases.reduce((n, p) => n + p.illegal + p.rejected, 0),
      holdRate: sum((s) => s.movementUnits) === 0 ? 0 : sum((s) => s.holds) / sum((s) => s.movementUnits),
      fallbacks: sum((s) => s.fallbacks),
      failovers: sum((s) => s.failovers),
      messages: sum((s) => s.messages),
      pledges,
      honesty: pledges.kept + pledges.broken === 0 ? null : pledges.kept / (pledges.kept + pledges.broken),
      costMicros,
      costUsd: microsToUsd(costMicros),
      usage: seats.reduce((u, s) => addUsage(u, s.usage), ZERO_USAGE),
    },
    divergences,
    elapsedMs: game.elapsedMs,
  };
}

export interface Gates {
  /** Highest acceptable off-menu rate. The issue's target is under one percent. */
  maxOffMenuRate: number;
  /** Highest acceptable cost of one game, in micro-dollars. */
  maxCostMicros: number;
  /** The year every game must reach, unless it ended in a solo first. */
  untilYear: number;
}

/** Why a game fails the nightly bar; empty when it passes. */
export function gateFailures(s: ArenaSummary, gates: Gates): string[] {
  const out: string[] = [];
  if (s.totals.illegalSubmitted > 0) out.push(`${s.totals.illegalSubmitted} illegal orders reached the adjudicator`);
  if (s.totals.offMenuRate >= gates.maxOffMenuRate) {
    out.push(`off-menu rate ${(s.totals.offMenuRate * 100).toFixed(2)}% is not under ${(gates.maxOffMenuRate * 100).toFixed(2)}%`);
  }
  if (s.totals.costMicros > gates.maxCostMicros) out.push(`cost $${s.totals.costUsd.toFixed(4)} is over the budget of $${microsToUsd(gates.maxCostMicros).toFixed(4)}`);
  if (s.divergences !== 0) out.push(`the saved game does not replay: ${s.divergences} divergences`);
  if (!s.status.startsWith("solo") && s.years.at(-1) !== gates.untilYear) out.push(`stopped in ${s.lastPhase ?? "no phase"}, before the end of ${gates.untilYear}`);
  if (s.totals.fallbacks > 0) out.push(`${s.totals.fallbacks} decisions fell back to holding every unit`);
  return out;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (micros: number) => `$${microsToUsd(micros).toFixed(4)}`;

/** A Markdown report of one or more games, for a workflow summary or a pull request. */
export function arenaReport(games: ArenaSummary[], gates: Gates, title = "Agent arena"): string {
  const lines: string[] = [`# ${title}`, ""];
  const all = games.flatMap((g) => gateFailures(g, gates).map((f) => `${g.gameId}: ${f}`));
  lines.push(all.length === 0 ? `All ${games.length} games pass the gates.` : `**${all.length} gate failures.**`, "");
  for (const f of all) lines.push(`- ${f}`);
  if (all.length) lines.push("");
  lines.push(
    "| Game | Result | Phases | Off-menu | Illegal submitted | Hold rate | Pledges (kept / broken / void) | Honesty | Fallbacks | Cost | Replay |",
    "|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|",
  );
  for (const g of games) {
    const t = g.totals;
    lines.push(
      `| ${g.gameId} | ${g.status === "active" ? `played to ${g.lastPhase}` : g.status} | ${g.phases} | ${t.offMenu} of ${t.proposed} (${pct(t.offMenuRate)}) | ${t.illegalSubmitted} | ${pct(t.holdRate)} | ${t.pledges.made} (${t.pledges.kept} / ${t.pledges.broken} / ${t.pledges.void}) | ${pct(t.honesty)} | ${t.fallbacks} | ${usd(t.costMicros)} | ${g.divergences === 0 ? "exact" : `${g.divergences} divergences`} |`,
    );
  }
  for (const g of games) {
    lines.push("", `## ${g.gameId}`, "", `Supply centres at the end of each year, then pledges and cost per seat.`, "");
    lines.push(`| Power | Brain | ${g.years.join(" | ")} | Pledges kept / broken | Messages | Holds | Cost |`);
    lines.push(`|---|---|${g.years.map(() => "---:").join("|")}|---|---:|---:|---:|`);
    for (const s of g.seats) {
      const brain = Object.keys(s.brains).join(", ") || "none";
      lines.push(
        `| ${s.power} | ${brain} | ${s.centres.join(" | ")} | ${s.pledges.kept} / ${s.pledges.broken} | ${s.messages} | ${pct(s.movementUnits ? s.holds / s.movementUnits : 0)} | ${usd(s.costMicros)} |`,
      );
    }
  }
  const tokens = games.reduce((u, g) => addUsage(u, g.totals.usage), ZERO_USAGE);
  const cost = games.reduce((n, g) => n + g.totals.costMicros, 0);
  lines.push(
    "",
    `Total cost ${usd(cost)} for ${games.length} games (${usd(games.length ? cost / games.length : 0)} per game). Tokens: ${tokens.inputTokens} input, ${tokens.outputTokens} output, ${tokens.cacheReadTokens} read from the cache, ${tokens.cacheWriteTokens} written to it.`,
  );
  return lines.join("\n") + "\n";
}
