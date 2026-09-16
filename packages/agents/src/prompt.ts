/**
 * Narrative prompts. Every published harness found that a story beats a JSON dump:
 * the board as a situation report, the legal orders as a menu, the press as a transcript.
 */
import type { LegalOrders, MapInfo, State } from "@cabal/engine";

export interface Relationship {
  power: string;
  /** -2 enemy .. +2 ally */
  stance: number;
  note: string;
}

export interface PromptInput {
  power: string;
  persona: string;
  phase: string;
  state: State;
  map: MapInfo;
  legal: LegalOrders;
  /** Press this phase, oldest first. */
  press: { from: string; to: string; body: string; pledge?: string[] | null }[];
  /** Recent private diary entries, oldest first. */
  diary: string[];
  relationships: Relationship[];
  /** Pledges this power made this phase (canonical orders), to keep or break knowingly. */
  myPledges: string[][];
  /** Public trust ledger of other powers: kept / broken counts. */
  trust: Record<string, { kept: number; broken: number }>;
}

export const SYSTEM_PROMPT = `You are playing Cabal, a game of Diplomacy with receipts.
Seven powers fight for 18 of 34 supply centres on the classic 1901 map. Orders are simultaneous
and resolved by a strict adjudicator. Negotiation is everything: alliances, promises and betrayals.

Cabal adds receipts. A message may carry a pledge: a commitment to specific orders. After the phase
resolves, every pledge is stamped kept or broken for everyone to see, and each power's trust ledger
follows it between games. Breaking a pledge is legal and sometimes correct, but it is never secret.

Play to win. Holds lose games: move units, take centres, coordinate supports. Keep the promises that
pay and break the ones that do not, knowing the ledger remembers. Write press that sounds like a
person, not a memo. Never mention that you are an AI.`;

function list(items: string[]): string {
  return items.length ? items.join(", ") : "none";
}

export function boardReport(input: PromptInput): string {
  const { state, map } = input;
  const lines: string[] = [];
  lines.push(`Phase ${input.phase}. You are ${input.power}.`);
  for (const [power, units] of Object.entries(state.units)) {
    const centers = state.centers[power] ?? [];
    lines.push(`${power}: ${centers.length} centres (${list(centers)}); units ${list(units)}`);
  }
  const neutral = map.provinces.filter(
    (p) => p.supply_center && !Object.values(state.centers).some((c) => c.includes(p.id)),
  );
  lines.push(`Unowned centres: ${list(neutral.map((p) => p.id))}`);
  return lines.join("\n");
}

export function legalMenu(input: PromptInput): string {
  const lines: string[] = [];
  for (const [unit, orders] of Object.entries(input.legal.by_unit)) {
    lines.push(`${unit || "builds"}:`);
    for (const o of orders) lines.push(`  ${o}`);
  }
  if (input.legal.allowance) lines.push(`Allowance: ${input.legal.allowance}`);
  return lines.join("\n");
}

export function userPrompt(input: PromptInput): string {
  const press = input.press.length
    ? input.press
        .map((m) => `${m.from} -> ${m.to}: ${m.body}${m.pledge ? ` [pledge: ${m.pledge.join("; ")}]` : ""}`)
        .join("\n")
    : "none";
  const diary = input.diary.length ? input.diary.map((d) => `- ${d}`).join("\n") : "none";
  const rel = input.relationships.length
    ? input.relationships.map((r) => `${r.power}: ${r.stance >= 0 ? "+" : ""}${r.stance} ${r.note}`).join("\n")
    : "no opinions yet";
  const trust = Object.entries(input.trust)
    .map(([p, t]) => `${p}: kept ${t.kept}, broken ${t.broken}`)
    .join("\n");
  const pledges = input.myPledges.length ? input.myPledges.map((p) => p.join("; ")).join("\n") : "none";
  return [
    `# Persona\n${input.persona}`,
    `# Situation\n${boardReport(input)}`,
    `# Your legal orders (choose only from this list, one per unit)\n${legalMenu(input)}`,
    `# Press this phase\n${press}`,
    `# Your pledges this phase\n${pledges}`,
    `# Trust ledger\n${trust || "empty"}`,
    `# Your relationships\n${rel}`,
    `# Your diary\n${diary}`,
    `# Task\nThink through the position, then answer with orders for every unit (from the menu), any
press you want to send now, an optional pledge to attach to one message, updated relationships and a
short diary entry. Retreat and build phases have their own menus; obey them.`,
  ].join("\n\n");
}
