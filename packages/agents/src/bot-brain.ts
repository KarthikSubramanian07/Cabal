/**
 * The free brain: Cabal's heuristic bot (the Rust crate `cabal-bot`, through `botOrders` in
 * `@cabal/engine`) behind the same `Brain` seam as Claude.
 *
 * It reads the structured situation, not the prose, and answers in a few milliseconds with no
 * network and no bill. Orders come straight from the bot. Press is small and honest about what it
 * is: when the bot supports another power's unit it says so and pledges the support, and otherwise
 * it offers the most dangerous neighbour it is not attacking a pledge on the units that border it.
 * That is enough for an arena to exercise every part of the table (press, pledges, receipts, the
 * ledger) for free.
 *
 * `treachery` is the one knob that is not the bot's: the chance, per pledge, that the seat breaks
 * it when the orders are final, by moving a pledged unit somewhere else, into the audience's
 * territory when it can. A ledger with nothing but kept pledges measures nothing.
 */
import { type BotLevel, Game, botOrders } from "@cabal/engine";
import type { Brain, BrainReply, BrainRequest, Decision } from "./player.js";
import { BrainFailure } from "./player.js";
import type { PromptInput } from "./prompt.js";

export interface BotBrainOptions {
  /** Any stable value, usually the game id: the same board, seed and level give the same orders. */
  seed: string | number;
  level?: BotLevel;
  /** Chance from 0 to 1 that a pledge made this phase is broken in the final orders. Default 0. */
  treachery?: number;
}

/** FNV-1a over a string, as a number in [0, 1): a seeded coin that needs no state. */
export function unitInterval(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 2 ** 32;
}

const provinceId = (text: string): string => text.replace(/^[AF] /, "").slice(0, 3);
const unitOf = (order: string): string => /^[AF] [A-Z]{3}(?:\/[A-Z]{2})?/.exec(order)?.[0] ?? "";

/** Provinces a unit standing in `id` could reach by land or sea, coasts folded. */
function neighbours(id: string, map: PromptInput["map"]): Set<string> {
  const p = map.provinces.find((q) => q.id === id);
  const out = new Set<string>();
  if (!p) return out;
  for (const to of p.army_adjacent) out.add(provinceId(to));
  for (const list of Object.values(p.fleet_adjacent)) for (const to of list ?? []) out.add(provinceId(to));
  return out;
}

export class BotBrain implements Brain {
  readonly model: string;
  private seed: string;
  private level: BotLevel;
  private treachery: number;

  constructor(opts: BotBrainOptions) {
    this.seed = String(opts.seed);
    this.level = opts.level ?? "standard";
    this.treachery = Math.max(0, Math.min(1, opts.treachery ?? 0));
    this.model = `cabal-bot/${this.level}`;
  }

  async decide(request: BrainRequest): Promise<BrainReply> {
    const s = request.situation;
    if (!s) throw new BrainFailure("the bot plays from the board, and this request carries none", "no", null, this.model);
    const game = Game.fromState(s.state);
    let chosen: ReturnType<typeof botOrders>;
    try {
      chosen = botOrders(game, s.power, { seed: this.seed, level: this.level });
    } catch (error) {
      throw new BrainFailure(`the bot could not play: ${error instanceof Error ? error.message : String(error)}`, "no", null, this.model);
    } finally {
      game.free();
    }
    const { intent } = chosen;
    let orders = chosen.orders;
    let messages: Decision["messages"] = [];
    let pledge: Decision["pledge"] = null;
    let diary = intent.targets.length ? `Going for ${intent.targets.slice(0, 3).join(", ")}.` : "Holding what I have.";
    if (request.kind === "M" && request.step === "negotiate") {
      ({ messages, pledge } = this.talk(s, orders, intent));
    } else if (request.kind === "M" && s.myPledges.length > 0) {
      const broken = this.betray(s, orders);
      if (broken) {
        orders = broken.orders;
        diary = `Broke my word to ${broken.audience}: ${broken.order}.`;
      }
    }
    const allies = new Set(intent.supports.map((x) => x.power).filter((p) => p !== s.power));
    const relationships = [
      ...[...allies].map((power) => ({ power, stance: 1, note: "we are working together" })),
      ...intent.against.filter((p) => p !== s.power && !allies.has(p)).map((power) => ({ power, stance: -1, note: "in my way" })),
    ].slice(0, 6);
    return {
      decision: {
        reasoning: `Bot (${this.level}): ${intent.candidates} candidate order sets compared.`,
        orders,
        messages,
        pledge,
        relationships,
        diary,
        plan: intent.targets.length ? `Take ${intent.targets.slice(0, 3).join(", ")}.` : "Hold the line.",
      },
      usage: null,
      model: this.model,
    };
  }

  /** The opening press: a pledged support for a partner, or a pledged quiet border. */
  private talk(s: PromptInput, orders: string[], intent: ReturnType<typeof botOrders>["intent"]): Pick<Decision, "messages" | "pledge"> {
    const foreign = intent.supports.find((x) => x.power !== s.power);
    if (foreign) {
      const supporting = orders.filter((o) => o.startsWith(`${foreign.unit} S `));
      const where = foreign.into ? `into ${foreign.into}` : "where it stands";
      return {
        messages: [{ to: foreign.power, body: `My ${foreign.unit} supports your ${foreign.supports} ${where} this season. On the record.` }],
        pledge: supporting.length ? { to: foreign.power, orders: supporting, sealed: false } : null,
      };
    }
    const neighbour = intent.fears.find((f) => f.power !== s.power && !intent.against.includes(f.power))?.power;
    if (!neighbour) return { messages: [], pledge: null };
    const theirs = new Set([...(s.state.units[neighbour] ?? []).map(provinceId), ...(s.state.centers[neighbour] ?? [])]);
    const border = orders.filter((o) => {
      const here = provinceId(unitOf(o));
      const to = / - ([A-Z]{3})/.exec(o)?.[1];
      return (to === undefined || !theirs.has(to)) && [...neighbours(here, s.map)].some((n) => theirs.has(n));
    });
    return {
      messages: [{ to: neighbour, body: "No moves against you this season. My units on our border are pledged to it." }],
      pledge: border.length ? { to: neighbour, orders: border, sealed: false } : null,
    };
  }

  /** With probability `treachery`, move one pledged unit elsewhere: into the audience's land if it can. */
  private betray(s: PromptInput, orders: string[]): { orders: string[]; audience: string; order: string } | null {
    if (this.treachery === 0 || unitInterval(`${this.seed}|${s.phase}|${s.power}|stab`) >= this.treachery) return null;
    const made = s.press.find((m) => m.from === s.power && m.pledge && m.pledge.length > 0);
    if (!made?.pledge) return null;
    const theirs = new Set([...(s.state.units[made.to] ?? []).map(provinceId), ...(s.state.centers[made.to] ?? [])]);
    for (const pledged of made.pledge) {
      const unit = unitOf(pledged);
      const options = (s.legal.by_unit[unit] ?? []).filter((o) => / - /.test(o) && !/ [SC] /.test(o) && o !== pledged);
      const stab = options.find((o) => theirs.has(/ - ([A-Z]{3})/.exec(o)?.[1] ?? "")) ?? options[0];
      if (stab === undefined) continue;
      return { orders: orders.map((o) => (unitOf(o) === unit ? stab : o)), audience: made.to, order: stab };
    }
    return null;
  }
}
