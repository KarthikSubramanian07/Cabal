/**
 * A Claude powered Cabal player.
 *
 * The model reasons in prose, then returns a structured decision. Orders are
 * validated against the engine's legal list; anything off-menu is repaired to
 * the closest legal order or dropped (the unit holds), so the seat never submits
 * an illegal order and never stalls a human game.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { type PromptInput, SYSTEM_PROMPT, userPrompt } from "./prompt.js";

export const Decision = z.object({
  reasoning: z.string().describe("Private strategic reasoning, under 300 words."),
  orders: z.array(z.string()).describe("One legal order per unit, copied exactly from the menu."),
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
  relationships: z.array(z.object({ power: z.string(), stance: z.number().int().min(-2).max(2), note: z.string() })),
  diary: z.string().describe("One or two sentences for your private diary."),
});
export type Decision = z.infer<typeof Decision>;

/** Anything that can turn a prompt into a decision; the Claude client is the default, tests inject a fake. */
export interface Brain {
  decide(system: string, prompt: string): Promise<Decision>;
}

export interface ClaudeBrainOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

/** Claude through structured outputs, adaptive thinking on. */
export class ClaudeBrain implements Brain {
  private client: Anthropic;
  private model: string;
  private effort: NonNullable<ClaudeBrainOptions["effort"]>;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5";
    this.effort = opts.effort ?? "medium";
  }

  async decide(system: string, prompt: string): Promise<Decision> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort, format: zodOutputFormat(Decision) },
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`no decision (stop_reason ${response.stop_reason})`);
    }
    return response.parsed_output;
  }
}

export interface Validated {
  orders: string[];
  dropped: { text: string; reason: string }[];
}

/** Keep only orders that are on the legal menu; at most one order per unit. */
export function validateOrders(decision: Decision, legal: Record<string, string[]>): Validated {
  const menu = new Map<string, string>(); // order -> unit
  for (const [unit, orders] of Object.entries(legal)) for (const o of orders) menu.set(o, unit);
  const seen = new Set<string>();
  const orders: string[] = [];
  const dropped: Validated["dropped"] = [];
  for (const raw of decision.orders) {
    const text = raw.trim().toUpperCase().replace(/\s+/g, " ");
    const unit = menu.get(text);
    if (unit === undefined) {
      // repair: same unit, same destination, different spelling of the verb
      const fixed = [...menu.keys()].find((o) => o.replace(/\s+/g, " ") === text.replace("->", "-"));
      if (fixed) {
        orders.push(fixed);
        seen.add(menu.get(fixed)!);
      } else {
        dropped.push({ text: raw, reason: "not on the legal menu" });
      }
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

export class Player {
  readonly power: string;
  readonly persona: string;
  private brain: Brain;
  diary: string[] = [];
  relationships: Map<string, { stance: number; note: string }> = new Map();

  constructor(power: string, persona: string, brain: Brain) {
    this.power = power;
    this.persona = persona;
    this.brain = brain;
  }

  /** Decide a phase. Never throws on model misbehaviour: falls back to holds. */
  async play(input: Omit<PromptInput, "power" | "persona" | "diary" | "relationships">): Promise<{
    decision: Decision;
    validated: Validated;
  }> {
    const full: PromptInput = {
      ...input,
      power: this.power,
      persona: this.persona,
      diary: this.diary.slice(-40),
      relationships: [...this.relationships].map(([power, r]) => ({ power, ...r })),
    };
    let decision: Decision;
    try {
      decision = await this.brain.decide(SYSTEM_PROMPT, userPrompt(full));
    } catch (e) {
      decision = {
        reasoning: `fallback: ${e instanceof Error ? e.message : String(e)}`,
        orders: [],
        messages: [],
        pledge: null,
        relationships: [],
        diary: "The turn passed in silence.",
      };
    }
    const validated = validateOrders(decision, input.legal.by_unit);
    for (const r of decision.relationships) this.relationships.set(r.power, { stance: r.stance, note: r.note });
    if (decision.diary) this.diary.push(`${input.phase}: ${decision.diary}`);
    return { decision, validated };
  }
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
