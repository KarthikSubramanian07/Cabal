/**
 * The decisions log: one plain JSON record per decision an AI seat makes, so a change to a prompt,
 * an effort level or a budget can be measured against what earlier games actually did and cost.
 *
 * A record carries no prices of its own. Tokens are the API's `usage` report and the cost is
 * `costMicros` from `cost.ts`, worked out once when the turn was played, so the log, the spend cap
 * and the bill all agree.
 */
import type { Usage } from "./cost.js";
import type { Decision, Played, Validated } from "./player.js";
import type { Step } from "./prompt.js";

/** One logged decision: what was asked, what was chosen, and what it cost. */
export interface DecisionRecord {
  /** The phase the decision was for, e.g. `S1901M`. */
  phase: string;
  /** The power that decided, in upper case. */
  power: string;
  step: Step;
  /** The model that answered, or null for an unmetered brain. */
  model: string | null;
  /** The prompt that was sent (the varying part; the system prefix is the same for every seat). */
  prompt: string;
  /** The orders that passed validation: what the seat actually submits. */
  orders: string[];
  /** Orders the model wrote that were off the legal menu, and why each was dropped. */
  dropped: Validated["dropped"];
  /** True when the brain failed and the built-in decision (every unit holds) was used. */
  fallback: boolean;
  /** The model's whole structured answer, reasoning and press included. */
  decision: Decision;
  /** Tokens the call used, whether or not it produced a decision. Null for an unmetered brain. */
  usage: Usage | null;
  /** What the call cost in micro-dollars (`microsToUsd` turns it into dollars). */
  costMicros: number;
}

/** The record of one played turn. The failure itself is left out; its message is in the reasoning. */
export function decisionRecord(phase: string, power: string, played: Played): DecisionRecord {
  return {
    phase,
    power,
    step: played.step,
    model: played.model,
    prompt: played.prompt,
    orders: played.validated.orders,
    dropped: played.validated.dropped,
    fallback: played.fallback,
    decision: played.decision,
    usage: played.usage,
    costMicros: played.costMicros,
  };
}
