/**
 * Text for people who cannot use the map: the choices a click on the board would
 * offer, the board itself as lists, and what to announce when something happens.
 *
 * Every choice is a province code fed to the same `click()` the map uses, so the
 * keyboard path can never compose an order the map could not.
 */
import type { PhaseOutcome, State } from "../engine.js";
import type { ComposeContext, Draft } from "./compose.js";
import { type PhaseKind, describePhase, parseOrder, parseUnit, titleCase } from "./notation.js";

export interface Choice {
  /** Province code to pass to `click()`. */
  code: string;
  label: string;
}

type Names = Record<string, { name: string } | undefined>;

export function provinceName(names: Names, code: string): string {
  const name = names[code]?.name;
  return name ? `${name} (${code})` : code;
}

function unitName(names: Names, unit: string): string {
  const ref = parseUnit(unit);
  if (!ref) return unit;
  const kind = ref.kind === "A" ? "Army" : "Fleet";
  const coast = ref.region.includes("/") ? ` ${ref.region.slice(4)}` : "";
  return `${kind} ${names[ref.province]?.name ?? ref.province}${coast}`;
}

/**
 * What the player can pick next, as buttons. `targets` is the set of provinces the
 * map highlights for the current draft; `units` are the active power's orderable units.
 */
export function choicesFor(
  ctx: ComposeContext,
  draft: Draft,
  active: string,
  units: string[],
  targets: ReadonlySet<string>,
  names: Names,
): Choice[] {
  if (ctx.phase === "A") {
    const seen = new Map<string, Choice>();
    for (const text of ctx.legal[active]?.[""] ?? []) {
      const o = parseOrder(text);
      if (!o || (o.type !== "build" && o.type !== "disband")) continue;
      const code = o.unit.province;
      if (seen.has(code)) continue;
      seen.set(
        code,
        o.type === "build"
          ? { code, label: `Build in ${provinceName(names, code)}` }
          : { code, label: `Disband ${o.unit.unit} in ${provinceName(names, code)}` },
      );
    }
    return [...seen.values()];
  }

  const at = (code: string) => provinceName(names, code);
  const standing = (code: string) => ctx.pieces.find((p) => p.province === code && !p.dislodged)?.unit;

  switch (draft.step) {
    case "idle":
      return units.map((unit) => {
        const code = parseUnit(unit)?.province ?? unit;
        return { code, label: `${unit}: ${unitName(names, unit)}` };
      });
    case "unit":
      return [...targets].sort().map((code) => ({
        code,
        label: `${ctx.phase === "R" ? "Retreat" : "Move"} to ${at(code)}`,
      }));
    case "support": {
      if (!draft.target) {
        return [...targets].sort().flatMap((code) => {
          const unit = standing(code);
          return unit ? [{ code, label: `Support ${unit}: ${unitName(names, unit)}` }] : [];
        });
      }
      const home = parseUnit(draft.target)?.province;
      return [...targets].sort().map((code) => ({
        code,
        label: code === home ? `Support ${draft.target} holding` : `Support ${draft.target} into ${at(code)}`,
      }));
    }
    case "convoy": {
      if (!draft.army) {
        return [...targets].sort().map((code) => ({ code, label: `Convoy ${standing(code) ?? code}` }));
      }
      return [...targets].sort().map((code) => ({ code, label: `Convoy ${draft.army} to ${at(code)}` }));
    }
  }
}

/** Heading for the choice list. */
export function choicePrompt(kind: PhaseKind, draft: Draft, power: string): string {
  if (kind === "A") return `${titleCase(power)}: build or disband`;
  switch (draft.step) {
    case "idle":
      return `${titleCase(power)}: choose a unit to order`;
    case "unit":
      return `${draft.unit}: choose where it goes`;
    case "support":
      return draft.target ? `${draft.unit} supports ${draft.target}: choose how` : `${draft.unit}: choose the unit to support`;
    case "convoy":
      return draft.army ? `${draft.unit} convoys ${draft.army}: choose where it lands` : `${draft.unit}: choose the army to convoy`;
  }
}

export interface PowerLines {
  power: string;
  units: string[];
  centers: string[];
}

/** The board as text: every power's units and supply centres. */
export function describeBoard(state: State, names: Names): PowerLines[] {
  const powers = [...new Set([...Object.keys(state.units), ...Object.keys(state.centers)])].sort();
  return powers.map((power) => ({
    power: titleCase(power),
    units: (state.units[power] ?? []).map((u) => {
      const dislodged = u.startsWith("*");
      const ref = parseUnit(u);
      const text = ref ? `${ref.unit}, ${unitName(names, ref.unit)}` : u;
      return dislodged ? `${text} (dislodged)` : text;
    }),
    centers: [...(state.centers[power] ?? [])].sort().map((c) => provinceName(names, c)),
  }));
}

/** One line on what an order means, for the announcement after it is given. */
export function describeOrder(text: string): string {
  return `Order given: ${text}.`;
}

/** Summary to announce once a phase has been adjudicated. */
export function describeOutcome(outcome: PhaseOutcome, given: ReadonlySet<string>): string {
  const { season, year, kind } = describePhase(outcome.phase);
  const counted = outcome.results.filter((r) => given.has(r.order) || !r.ok);
  const ok = counted.filter((r) => r.ok).length;
  const failed = counted.length - ok;
  const parts = [`${season} ${year} ${kind.toLowerCase()} resolved.`.replace(/\s+/g, " ")];
  if (counted.length) parts.push(`${ok} ${ok === 1 ? "order" : "orders"} succeeded, ${failed} failed.`);
  for (const d of outcome.dislodged) parts.push(`${d.unit} was dislodged.`);
  if (outcome.standoffs.length) parts.push(`Standoff in ${outcome.standoffs.join(", ")}.`);
  parts.push(statusLine(outcome.status) ?? `Next: ${phaseLine(outcome.next.name)}. The results are listed beside the board.`);
  return parts.join(" ");
}

export function phaseLine(phase: string): string {
  const { season, year, kind } = describePhase(phase);
  return [season, year, kind.toLowerCase()].filter(Boolean).join(" ");
}

export function statusLine(status: string): string | null {
  if (status.startsWith("solo:")) return `${titleCase(status.slice(5))} wins outright.`;
  if (status === "draw") return "The game ended in a draw.";
  return null;
}
