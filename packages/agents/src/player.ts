/**
 * A Claude powered Cabal player.
 *
 * The model reasons in prose, then returns a structured decision. Orders are validated against the
 * engine's legal list; anything off-menu is repaired to the matching legal order or dropped (the
 * unit holds), so the seat never submits an illegal order and never stalls a human game.
 *
 * A player's memory (diary and relationships) is plain data: `memory()` returns it and `restore()`
 * puts it back, so whoever runs the player can keep it between turns. A server that builds a
 * fresh player for every turn stores it; a long-lived client just keeps the object.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LegalOrders } from "@cabal/engine";
import { z } from "zod";
import { type Usage, costMicros } from "./cost.js";
import { type PromptInput, type Step, phaseKind, systemPrompt, userPrompt } from "./prompt.js";

/**
 * The shape the model must return. Structured outputs cannot enforce numeric ranges or lengths, so
 * none are declared here: a schema that says more than the API guarantees turns one stray value
 * into a lost turn. Ranges are clamped in `Player.play` instead.
 */
export const Decision = z.object({
  reasoning: z.string().describe("Private strategic reasoning, under 300 words."),
  orders: z.array(z.string()).describe("Legal orders copied exactly from the menu: one per unit, or as many adjustments as the allowance."),
  messages: z
    .array(
      z.object({
        to: z.string().describe("A power name in upper case, or ALL"),
        body: z.string(),
      }),
    )
    .describe("Press to send now. Empty array if silent."),
  pledge: z
    .object({
      to: z.string(),
      orders: z.array(z.string()).describe("Orders from the menu you commit to, attached to the message to `to`."),
      sealed: z.boolean(),
    })
    .nullable()
    .describe("Optional pledge attached to one of the messages above."),
  relationships: z.array(
    z.object({
      power: z.string(),
      stance: z.number().describe("A whole number from -2 (enemy) to 2 (ally)."),
      note: z.string(),
    }),
  ),
  diary: z.string().describe("One or two sentences for your private diary."),
  plan: z
    .string()
    .optional()
    .describe("Only when the task asks for it: your plan for the year, two or three sentences."),
  yearSummary: z
    .string()
    .optional()
    .describe("Only when the task asks for it: the year your diary covers, in two sentences."),
});
export type Decision = z.infer<typeof Decision>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One request for a decision. `kind` and `step` let a brain spend less on phases that need less. */
export interface BrainRequest {
  /** The stable prefix: instructions, rules and the map. Identical for every seat and every phase. */
  system: string;
  /** Everything that changes: persona, board, menu, press, memory, task. */
  prompt: string;
  kind: "M" | "R" | "A";
  step: Step;
}

export interface BrainReply {
  decision: Decision;
  /** Null when the brain is not a metered model (a scripted or local brain). */
  usage: Usage | null;
  model: string | null;
}

/** Anything that can turn a prompt into a decision; the Claude client is the default, tests inject a fake. */
export interface Brain {
  decide(request: BrainRequest): Promise<BrainReply>;
}

/**
 * A brain that could not produce a decision. `usage` is what the failed attempt cost, when the API
 * answered at all. `billed` says whether money may have been spent: `no` for a request the API
 * rejected or never received, `yes` when usage is known, `unknown` for a timeout, where the request
 * may have completed on the far side.
 */
export class BrainFailure extends Error {
  override readonly name = "BrainFailure";
  constructor(
    message: string,
    readonly billed: "no" | "yes" | "unknown",
    readonly usage: Usage | null = null,
    readonly model: string | null = null,
    /** HTTP status when the API refused the request; a 4xx will fail the same way again. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface ClaudeBrainOptions {
  apiKey?: string;
  model?: string;
  /** One effort for every request, or one per kind of request. Defaults to `DEFAULT_EFFORT`. */
  effort?: Effort | Partial<EffortPlan>;
  /** Request timeout in milliseconds (the SDK default is ten minutes). */
  timeoutMs?: number;
  /** SDK retries on 408, 409, 429 and 5xx (the SDK default is 2). */
  maxRetries?: number;
  client?: Anthropic;
}

export interface EffortPlan {
  /** The opening, talking half of a movement phase. */
  negotiate: Effort;
  /** Final movement orders: the decision that wins or loses centres. */
  movement: Effort;
  retreat: Effort;
  adjustment: Effort;
}

/**
 * Movement orders get the model's default depth; talking, retreats and builds are small decisions
 * from short menus and get the cheapest. Effort is part of what the API caches on, so each level
 * keeps its own copy of the cached prefix: two levels, two cache entries, both shared by all seats.
 */
export const DEFAULT_EFFORT: EffortPlan = { negotiate: "low", movement: "medium", retreat: "low", adjustment: "low" };

/** Output allowance per kind of request. It bounds what one call can cost; see `maxCallCostMicros`. */
export const MAX_OUTPUT_TOKENS = { negotiate: 4000, movement: 8000, retreat: 4000, adjustment: 4000 } as const;

/**
 * The longest prompt a `ClaudeBrain` will send, in UTF-8 bytes: the system and user parts and the
 * output schema together. A longer one is refused before the request, so the input side of a
 * call's cost is bounded too.
 *
 * The bound is in bytes because bytes bound tokens: a token is never shorter than one byte,
 * whatever the script. A bound in characters does not: prompts quote player-written press, and
 * CJK, emoji and rare scripts cost a token per character or more. `MAX_INPUT_TOKENS` adds a fixed
 * allowance for what the API wraps around the text (roles, the structured-output instructions).
 */
export const MAX_PROMPT_BYTES = 48_000;
export const PROMPT_FRAMING_TOKENS = 1_000;
export const MAX_INPUT_TOKENS = MAX_PROMPT_BYTES + PROMPT_FRAMING_TOKENS;

const utf8 = new TextEncoder();
/** UTF-8 size of a string. */
export const byteLength = (text: string): number => utf8.encode(text).byteLength;

export const DEFAULT_MODEL = "claude-opus-5-5";

export function requestKind(kind: "M" | "R" | "A", step: Step): keyof EffortPlan {
  if (kind === "R") return "retreat";
  if (kind === "A") return "adjustment";
  return step === "negotiate" ? "negotiate" : "movement";
}

const DecisionFormat = zodOutputFormat(Decision);

/** Claude through structured outputs, adaptive thinking on, the static prefix cached. */
export class ClaudeBrain implements Brain {
  private client: Anthropic;
  readonly model: string;
  private effort: EffortPlan;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.effort =
      typeof opts.effort === "string"
        ? { negotiate: opts.effort, movement: opts.effort, retreat: opts.effort, adjustment: opts.effort }
        : { ...DEFAULT_EFFORT, ...opts.effort };
  }

  async decide(request: BrainRequest): Promise<BrainReply> {
    const promptBytes = byteLength(request.system) + byteLength(request.prompt) + byteLength(JSON.stringify(DecisionFormat.schema));
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new BrainFailure(`prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES} its cost cap assumes`, "no", null, this.model);
    }
    const kind = requestKind(request.kind, request.step);
    let response: Anthropic.Message;
    try {
      // `create`, not `parse`: a reply that fails to parse must still report what it cost.
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS[kind],
        // The breakpoint sits at the end of the static prefix; nothing volatile comes before it.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort[kind], format: { type: "json_schema", schema: DecisionFormat.schema } },
        messages: [{ role: "user", content: request.prompt }],
      });
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new BrainFailure("the model timed out", "unknown", null, this.model);
      }
      if (error instanceof Anthropic.APIError) {
        // A request the API rejected is not billed. Anything else (a 5xx, a dropped connection) may
        // have run to completion on the far side, so it is never claimed to be free.
        const status = typeof error.status === "number" ? error.status : null;
        const billed = status !== null && status >= 400 && status < 500 ? "no" : "unknown";
        throw new BrainFailure(`model request failed: ${error.message}`, billed, null, this.model, status);
      }
      throw new BrainFailure(`model request failed: ${error instanceof Error ? error.message : String(error)}`, "unknown", null, this.model);
    }
    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    if (response.stop_reason !== "end_turn") {
      // A refusal, or an answer cut off by the output allowance: there is no decision to read.
      throw new BrainFailure(`no decision (stop_reason ${response.stop_reason})`, "yes", usage, this.model);
    }
    const text = response.content.find((block): block is Anthropic.TextBlock => block.type === "text")?.text;
    let parsed: ReturnType<typeof Decision.safeParse> | undefined;
    try {
      parsed = Decision.safeParse(JSON.parse(text ?? ""));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success) throw new BrainFailure("the model's reply did not match the decision schema", "yes", usage, this.model);
    return { decision: parsed.data, usage, model: this.model };
  }
}

/** Used when no model API key is configured; the player then holds. */
export class FallbackBrain implements Brain {
  async decide(): Promise<BrainReply> {
    throw new BrainFailure("no model provider configured", "no");
  }
}

export interface Validated {
  orders: string[];
  dropped: { text: string; reason: string }[];
}

/** Spellings the model drifts into, folded onto the engine's canonical notation. */
function normalise(text: string): string {
  return text
    .trim()
    .toUpperCase()
    // A note the model copied from the menu's framing, `A PAR - BUR (EMPTY)`, is not part of the order.
    .replace(/\s*[([][^()[\]]*[)\]]$/, "")
    .replace(/^[A-Z]+:\s*/, "")
    .replace(/[.;,]+$/, "")
    .replace(/\s*-+>\s*/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/ (HOLDS?|STANDS?)$/, " H")
    .replace(/ (SUPPORTS?) /, " S ")
    .replace(/ (CONVOYS?) /, " C ")
    .replace(/ (RETREATS?( TO)?) /, " R ")
    .replace(/ (DISBANDS?)$/, " D")
    .replace(/ (BUILDS?)$/, " B")
    .replace(/ (MOVES?( TO)?|TO) /, " - ");
}

/** `A PAR B`, `F STP/SC B`, `A MUN D` -> `PAR`, `STP`, `MUN`. */
function provinceOf(order: string): string | null {
  return /^[AF] ([A-Z]{3})/.exec(order)?.[1] ?? null;
}

/**
 * Keep only orders that are on the legal menu.
 *
 * Movement and retreat menus are keyed by unit: at most one order per unit, whichever spelling the
 * model used. An adjustment menu is one list for the whole power: as many orders as the allowance
 * (builds when positive, disbands when negative), each for a different province.
 */
export function validateOrders(decision: Pick<Decision, "orders">, legal: LegalOrders | Record<string, string[]>): Validated {
  const byUnit = ("by_unit" in legal && typeof legal.by_unit === "object" ? legal.by_unit : legal) as Record<string, string[]>;
  const allowance = "allowance" in legal && typeof legal.allowance === "number" ? legal.allowance : 0;
  const menu = new Map<string, string>(); // canonical order -> unit
  for (const [unit, options] of Object.entries(byUnit)) for (const o of options) menu.set(o, unit);
  const seen = new Set<string>();
  const provinces = new Set<string>();
  let adjustments = 0;
  const orders: string[] = [];
  const dropped: Validated["dropped"] = [];
  for (const raw of decision.orders) {
    const text = normalise(raw);
    const unit = menu.get(text);
    if (unit === undefined) {
      dropped.push({ text: raw, reason: "not on the legal menu" });
      continue;
    }
    if (unit === "") {
      // The adjustment list. A waive may repeat; everything else is one order per province.
      const province = provinceOf(text);
      if (adjustments >= Math.abs(allowance)) {
        dropped.push({ text: raw, reason: `more than the allowance of ${Math.abs(allowance)}` });
        continue;
      }
      if (province !== null && provinces.has(province)) {
        dropped.push({ text: raw, reason: `second order for ${province}` });
        continue;
      }
      if (province !== null) provinces.add(province);
      adjustments++;
      orders.push(text);
      continue;
    }
    if (seen.has(unit)) {
      dropped.push({ text: raw, reason: `second order for ${unit}` });
      continue;
    }
    seen.add(unit);
    orders.push(text);
  }
  return { orders, dropped };
}

/** What a player remembers between turns. Plain JSON, so it can be stored anywhere. */
export interface Memory {
  /** One line per turn, oldest first, each prefixed with its phase. */
  diary: string[];
  relationships: { power: string; stance: number; note: string }[];
}

export const MEMORY_LIMITS = { diaryEntries: 40, diaryChars: 400, noteChars: 200, relationships: 7 } as const;

const clampStance = (stance: number): number => (Number.isFinite(stance) ? Math.max(-2, Math.min(2, Math.round(stance))) : 0);

export type PlayInput = Omit<PromptInput, "power" | "persona" | "diary" | "relationships">;

export interface Played {
  decision: Decision;
  validated: Validated;
  /** True when the brain failed and the decision is the built-in one (every unit holds). */
  fallback: boolean;
  /** Why the brain failed, when it did. */
  failure: BrainFailure | null;
  step: Step;
  model: string | null;
  /** Tokens the turn used, whether or not it produced a decision. Null for an unmetered brain. */
  usage: Usage | null;
  /** What the turn cost in micro-dollars (0 for an unmetered brain or an unbilled failure). */
  costMicros: number;
  /** The prompt that was sent, for logs and evaluations. */
  prompt: string;
}

export class Player {
  readonly power: string;
  readonly persona: string;
  private brain: Brain;
  diary: string[] = [];
  relationships: Map<string, { stance: number; note: string }> = new Map();

  constructor(power: string, persona: string, brain: Brain, memory?: Memory) {
    this.power = power;
    this.persona = persona;
    this.brain = brain;
    if (memory) this.restore(memory);
  }

  /** Everything this player remembers, bounded, ready to store. */
  memory(): Memory {
    return {
      diary: this.diary.slice(-MEMORY_LIMITS.diaryEntries),
      relationships: [...this.relationships].map(([power, r]) => ({ power, stance: r.stance, note: r.note })),
    };
  }

  /** Replace this player's memory with a stored one. Tolerates anything a store hands back. */
  restore(memory: Memory): void {
    this.diary = (Array.isArray(memory.diary) ? memory.diary : [])
      .filter((entry): entry is string => typeof entry === "string")
      .slice(-MEMORY_LIMITS.diaryEntries)
      .map((entry) => entry.slice(0, MEMORY_LIMITS.diaryChars));
    this.relationships = new Map();
    for (const r of Array.isArray(memory.relationships) ? memory.relationships : []) this.remember(r);
  }

  private remember(r: { power: string; stance: number; note: string }): void {
    if (typeof r?.power !== "string") return;
    const power = r.power.trim().toUpperCase().slice(0, 16);
    if (!power || power === this.power) return;
    if (!this.relationships.has(power) && this.relationships.size >= MEMORY_LIMITS.relationships) return;
    this.relationships.set(power, {
      stance: clampStance(Number(r.stance)),
      note: String(r.note ?? "").slice(0, MEMORY_LIMITS.noteChars),
    });
  }

  /**
   * Decide one step of a phase. Never throws on model misbehaviour: the fallback decision holds
   * every unit, says nothing and leaves memory alone, and `fallback` is true so a caller with
   * better orders of its own (the server's bot) can keep them.
   */
  async play(input: PlayInput): Promise<Played> {
    const step: Step = input.step ?? "order";
    const full: PromptInput = {
      ...input,
      step,
      power: this.power,
      persona: this.persona,
      diary: this.diary.slice(-MEMORY_LIMITS.diaryEntries),
      relationships: [...this.relationships].map(([power, r]) => ({ power, ...r })),
    };
    const year = yearOf(input.phase);
    const kind = phaseKind(input.phase);
    // The first movement decision of a year is also the year's planning step, and the moment the
    // diary of the years before it is folded into one line each.
    const planning = year !== null && kind === "M" && !this.diary.some((entry) => entry.startsWith(`${year} plan: `));
    const stale = year === null ? [] : staleYears(this.diary, year);
    if (year !== null) {
      full.plan = this.diary.find((entry) => entry.startsWith(`${year} plan: `))?.slice(`${year} plan: `.length) ?? null;
      full.diary = full.diary.filter((entry) => !entry.startsWith(`${year} plan: `));
    }
    full.planning = planning;
    full.summarise = planning ? (stale.at(-1) ?? null) : null;
    const prompt = userPrompt(full);
    let decision: Decision;
    let failure: BrainFailure | null = null;
    let usage: Usage | null = null;
    let model: string | null = null;
    try {
      const reply = await this.brain.decide({ system: systemPrompt(input.map), prompt, kind, step });
      decision = reply.decision;
      usage = reply.usage;
      model = reply.model;
    } catch (e) {
      failure = e instanceof BrainFailure ? e : new BrainFailure(e instanceof Error ? e.message : String(e), "unknown");
      usage = failure.usage;
      model = failure.model;
      // Deterministic and harmless: hold in movement, and let the engine's own defaults (disband,
      // waive) cover a retreat or adjustment.
      const holds = Object.values(input.legal.by_unit).flatMap((menu) => menu.filter((o) => o.endsWith(" H")).slice(0, 1));
      decision = {
        reasoning: `fallback: ${failure.message}`,
        orders: holds,
        messages: [],
        pledge: null,
        relationships: [],
        diary: "",
      };
    }
    const validated = validateOrders(decision, input.legal);
    // One stray value must never cost the turn: clamp what the schema cannot enforce.
    decision = {
      ...decision,
      relationships: decision.relationships.map((r) => ({ ...r, stance: clampStance(r.stance) })),
    };
    for (const r of decision.relationships) this.remember(r);
    if (failure === null && year !== null) {
      // One line per finished year, written by the model when it was asked to, else mechanically.
      this.diary = consolidate(this.diary, stale, full.summarise === null ? null : (decision.yearSummary ?? null));
      const plan = planning ? (decision.plan ?? "").trim() : "";
      if (plan) this.diary = [...this.diary, `${year} plan: ${plan}`.slice(0, MEMORY_LIMITS.diaryChars)];
    }
    const entry = decision.diary.trim();
    if (entry) {
      const line = `${input.phase}${step === "negotiate" ? " (talks)" : ""}: ${entry}`.slice(0, MEMORY_LIMITS.diaryChars);
      this.diary = [...this.diary, line];
    }
    this.diary = this.diary.slice(-MEMORY_LIMITS.diaryEntries);
    return {
      decision,
      validated,
      fallback: failure !== null,
      failure,
      step,
      model,
      usage,
      costMicros: usage && model ? costMicros(model, usage) : 0,
      prompt,
    };
  }
}

/** The year of a phase name (`S1901M` -> 1901), or null for a name that is not one. */
export function yearOf(phase: string): number | null {
  const m = /^[SFW](\d{4})[MRA]$/.exec(phase);
  return m ? Number(m[1]) : null;
}

/** The year a diary entry belongs to: `S1901M: ...`, `1901 plan: ...` or `1901 in brief: ...`. */
function entryYear(entry: string): number | null {
  const m = /^(?:[SFW](\d{4})[MRA]\b|(\d{4}) (?:plan|in brief):)/.exec(entry);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Years before `year` that still have more than their one-line brief in the diary, oldest first. */
export function staleYears(diary: string[], year: number): number[] {
  const years = new Set<number>();
  for (const entry of diary) {
    const y = entryYear(entry);
    if (y !== null && y < year && !entry.startsWith(`${y} in brief: `)) years.add(y);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * Fold each stale year's entries into one `YEAR in brief:` line, in place of its first entry. The
 * newest stale year takes `summary` when the model wrote one; every other year, and that one when
 * it did not, is folded mechanically: its entries joined and clipped.
 */
export function consolidate(diary: string[], years: number[], summary: string | null): string[] {
  if (years.length === 0) return diary;
  const newest = years.at(-1);
  const out: string[] = [];
  const folded = new Set<number>();
  for (const entry of diary) {
    const y = entryYear(entry);
    if (y === null || !years.includes(y)) {
      out.push(entry);
      continue;
    }
    if (folded.has(y)) continue;
    folded.add(y);
    const written = y === newest ? (summary ?? "").trim() : "";
    const text =
      written ||
      diary
        .filter((e) => entryYear(e) === y)
        .map((e) => e.replace(/^[^:]*: /, ""))
        .join(" / ");
    out.push(`${y} in brief: ${text}`.slice(0, MEMORY_LIMITS.diaryChars));
  }
  return out;
}

/** Seven default personas, one per power, written to be memorable at the table. */
export const PERSONAS: Record<string, string> = {
  AUSTRIA: "The Archduke's last loyal minister: courteous, defensive, and vengeful when betrayed.",
  ENGLAND: "An admiral who trusts the sea and nobody on it. Patient, literal, keeps every receipt.",
  FRANCE: "A charming foreign minister who promises everyone dinner and means it until dessert.",
  GERMANY: "An industrialist who talks in timetables. Wants Belgium, Holland and a quiet Russia.",
  ITALY: "A cardinal's nephew: theatrical, opportunistic, secretly sentimental about Austria.",
  RUSSIA: "A tsarina's spymaster. Plays the long game, remembers every slight, forgives none.",
  TURKEY: "A grand vizier who speaks softly and moves fleets into the Black Sea anyway.",
};
