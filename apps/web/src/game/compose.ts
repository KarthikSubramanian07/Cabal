/**
 * Order composition by clicking the board, in the style players know from
 * Backstabbr: click a unit, then where it goes. Click it twice to hold.
 * Press S (or the Support button) to support, C to convoy.
 *
 * Pure functions over a small context so every path is unit tested. Nothing is
 * composed that the engine did not list as legal.
 */
import { type PhaseKind, parseOrder, parseUnit, provinceOf } from "./notation.js";

export type Mode = "move" | "support" | "convoy";

export type Draft =
  | { step: "idle" }
  | { step: "unit"; power: string; unit: string }
  | { step: "support"; power: string; unit: string; target?: string }
  | { step: "convoy"; power: string; unit: string; army?: string };

export interface Piece {
  power: string;
  /** `A PAR`, `F STP/SC` */
  unit: string;
  /** `PAR`, `STP` */
  province: string;
  dislodged: boolean;
}

export interface ComposeContext {
  phase: PhaseKind;
  pieces: Piece[];
  /** Legal orders by power then unit. Adjustment orders are listed under `""`. */
  legal: Record<string, Record<string, string[]>>;
}

export type Effect =
  | { kind: "none" }
  | { kind: "order"; power: string; key: string; text: string }
  | { kind: "choose"; power: string; key: string; title: string; options: string[] }
  | { kind: "message"; text: string };

export interface Step {
  draft: Draft;
  effect: Effect;
}

const IDLE: Draft = { step: "idle" };
const none = (draft: Draft): Step => ({ draft, effect: { kind: "none" } });
const say = (draft: Draft, text: string): Step => ({ draft, effect: { kind: "message", text } });

function legalFor(ctx: ComposeContext, power: string, unit: string): string[] {
  return ctx.legal[power]?.[unit] ?? [];
}

/** The piece a click on `province` would select, if any. */
export function orderablePiece(ctx: ComposeContext, province: string): Piece | undefined {
  if (ctx.phase === "A") return undefined;
  return ctx.pieces.find(
    (p) =>
      p.province === province &&
      p.dislodged === (ctx.phase === "R") &&
      legalFor(ctx, p.power, p.unit).length > 0,
  );
}

function standingPiece(ctx: ComposeContext, province: string): Piece | undefined {
  return ctx.pieces.find((p) => p.province === province && !p.dislodged);
}

function orderStep(power: string, key: string, text: string): Step {
  return { draft: IDLE, effect: { kind: "order", power, key, text } };
}

/** Handle a click on a province. */
export function click(ctx: ComposeContext, draft: Draft, province: string): Step {
  if (ctx.phase === "A") return adjustmentClick(ctx, draft, province);

  switch (draft.step) {
    case "idle": {
      const piece = orderablePiece(ctx, province);
      return piece ? none({ step: "unit", power: piece.power, unit: piece.unit }) : none(IDLE);
    }

    case "unit": {
      const { power, unit } = draft;
      const own = parseUnit(unit)!;
      const legal = legalFor(ctx, power, unit);
      if (province === own.province) {
        if (ctx.phase === "R") return none(IDLE);
        const hold = `${unit} H`;
        return legal.includes(hold) ? orderStep(power, unit, hold) : say(draft, `${unit} cannot hold.`);
      }
      const wanted = ctx.phase === "R" ? "retreat" : "move";
      let options = legal.filter((o) => {
        const parsed = parseOrder(o);
        return parsed?.type === wanted && provinceOf(parsed.dest) === province;
      });
      if (options.length === 0) {
        const other = orderablePiece(ctx, province);
        if (other) return none({ step: "unit", power: other.power, unit: other.unit });
        return say(draft, `${unit} cannot ${wanted === "move" ? "move" : "retreat"} to ${province}.`);
      }
      if (wanted === "move") {
        const direct = options.filter((o) => !o.endsWith(" VIA"));
        if (direct.length > 0) options = direct;
      }
      if (options.length === 1) return orderStep(power, unit, options[0]!);
      return {
        draft: IDLE,
        effect: { kind: "choose", power, key: unit, title: `${unit} to which coast?`, options },
      };
    }

    case "support": {
      const { power, unit, target } = draft;
      if (!target) {
        const piece = standingPiece(ctx, province);
        if (!piece || piece.unit === unit) return say(draft, "Click the unit you want to support.");
        return none({ ...draft, target: piece.unit });
      }
      const text =
        province === parseUnit(target)!.province ? `${unit} S ${target}` : `${unit} S ${target} - ${province}`;
      return legalFor(ctx, power, unit).includes(text)
        ? orderStep(power, unit, text)
        : say(draft, `${text} is not a legal order.`);
    }

    case "convoy": {
      const { power, unit, army } = draft;
      if (!army) {
        const piece = standingPiece(ctx, province);
        if (!piece || parseUnit(piece.unit)!.kind !== "A") return say(draft, "Click the army you want to convoy.");
        return none({ ...draft, army: piece.unit });
      }
      const text = `${unit} C ${army} - ${province}`;
      return legalFor(ctx, power, unit).includes(text)
        ? orderStep(power, unit, text)
        : say(draft, `${text} is not a legal order.`);
    }
  }
}

/** Switch the selected unit into support or convoy mode (S and C keys). */
export function setMode(ctx: ComposeContext, draft: Draft, mode: Mode): Step {
  if (draft.step === "idle") return say(draft, "Select one of your units first.");
  const { power, unit } = draft;
  if (mode === "move") return none({ step: "unit", power, unit });
  if (ctx.phase !== "M") return say(draft, "Supports and convoys are only ordered in movement phases.");
  if (mode === "support") {
    const canSupport = legalFor(ctx, power, unit).some((o) => o.startsWith(`${unit} S `));
    return canSupport ? none({ step: "support", power, unit }) : say(draft, `${unit} has nothing to support.`);
  }
  const canConvoy = legalFor(ctx, power, unit).some((o) => o.startsWith(`${unit} C `));
  return canConvoy ? none({ step: "convoy", power, unit }) : say(draft, "Only a fleet at sea can convoy.");
}

/** Order the selected unit to hold (H key). */
export function holdSelected(ctx: ComposeContext, draft: Draft): Step {
  if (draft.step === "idle" || ctx.phase !== "M") return none(draft);
  const hold = `${draft.unit} H`;
  return legalFor(ctx, draft.power, draft.unit).includes(hold) ? orderStep(draft.power, draft.unit, hold) : none(draft);
}

/** Disband the selected dislodged unit (D key in retreat phases). */
export function disbandSelected(ctx: ComposeContext, draft: Draft): Step {
  if (draft.step === "idle" || ctx.phase !== "R") return none(draft);
  const text = `${draft.unit} D`;
  return legalFor(ctx, draft.power, draft.unit).includes(text)
    ? orderStep(draft.power, draft.unit, text)
    : none(draft);
}

function adjustmentClick(ctx: ComposeContext, draft: Draft, province: string): Step {
  const found: { power: string; options: string[] }[] = [];
  for (const [power, byUnit] of Object.entries(ctx.legal)) {
    const options = (byUnit[""] ?? []).filter((o) => {
      const parsed = parseOrder(o);
      return (parsed?.type === "build" || parsed?.type === "disband") && parsed.unit.province === province;
    });
    if (options.length) found.push({ power, options });
  }
  const first = found[0];
  if (!first) return say(draft, `No build or disband is possible in ${province}.`);
  const { power, options } = first;
  const isDisband = parseOrder(options[0]!)?.type === "disband";
  const key = `${isDisband ? "D" : "B"}:${province}`;
  if (options.length === 1) return orderStep(power, key, options[0]!);
  return { draft: IDLE, effect: { kind: "choose", power, key, title: `Build in ${province}`, options } };
}
