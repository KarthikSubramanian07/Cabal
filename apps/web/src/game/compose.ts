/**
 * Order composition by clicking the board, in the style players know from
 * Backstabbr: click a unit, then where it goes. Click it twice to hold.
 * Press S (or the Support button) to support, C to convoy, V to send an army by convoy.
 *
 * Pure functions over a small context so every path is unit tested. Nothing is
 * composed that the engine did not list as legal.
 */
import { type PhaseKind, forUnit, parseOrder, parseUnit, provinceOf, titleCase } from "./notation.js";

export type Mode = "move" | "via-convoy" | "support" | "convoy";

export type Draft =
  | { step: "idle" }
  | { step: "unit"; power: string; unit: string; via?: boolean }
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
  /** The power whose orders are open beside the board. A click on a province more than one power could act in goes to this one. */
  active?: string | undefined;
  /** Adjustment phases: builds (positive) or disbands (negative) each power is owed. */
  allowance?: Record<string, number> | undefined;
  /** Orders already written, by power then key, so adjustments can be capped at the allowance. */
  orders?: Record<string, Record<string, string>> | undefined;
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
        // Where the army could walk or be carried, the click gives the land route unless the
        // player switched to "by convoy" first (V). The order's own switch (see `viaAlternative`)
        // changes it afterwards.
        const carried = options.filter((o) => o.endsWith(" VIA"));
        if (draft.via) {
          if (carried.length === 0) {
            return say(draft, `No fleet can carry ${unit} to ${province}. Switch off By convoy to go by land.`);
          }
          options = carried;
        } else {
          const direct = options.filter((o) => !o.endsWith(" VIA"));
          if (direct.length > 0) options = direct;
        }
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

/** Switch the selected unit into an order mode: M, S, C, and V for a move by convoy. */
export function setMode(ctx: ComposeContext, draft: Draft, mode: Mode): Step {
  if (draft.step === "idle") return say(draft, "Select one of your units first.");
  const { power, unit } = draft;
  if (mode === "move") return none({ step: "unit", power, unit });
  if (ctx.phase !== "M") return say(draft, "Supports and convoys are only ordered in movement phases.");
  if (mode === "via-convoy") {
    // A second press goes back to the land route.
    if (draft.step === "unit" && draft.via) return none({ step: "unit", power, unit });
    return canGoByConvoy(ctx, power, unit)
      ? none({ step: "unit", power, unit, via: true })
      : say(draft, `No fleet is placed to carry ${unit} anywhere.`);
  }
  if (mode === "support") {
    const canSupport = legalFor(ctx, power, unit).some((o) => o.startsWith(`${unit} S `));
    return canSupport ? none({ step: "support", power, unit }) : say(draft, `${unit} has nothing to support.`);
  }
  const canConvoy = legalFor(ctx, power, unit).some((o) => o.startsWith(`${unit} C `));
  return canConvoy ? none({ step: "convoy", power, unit }) : say(draft, "Only a fleet at sea can convoy.");
}

/** Whether some fleet could carry `unit` this phase: the engine lists a `... VIA` move for it. */
export function canGoByConvoy(ctx: ComposeContext, power: string, unit: string): boolean {
  return ctx.phase === "M" && legalFor(ctx, power, unit).some((o) => o.endsWith(" VIA"));
}

/** A fleet that could carry a convoyed move, and whether it has been ordered to. */
export interface CarryingFleet {
  power: string;
  /** `F ENG` */
  unit: string;
  /** `F ENG C A WAL - LON` */
  order: string;
  /** The fleet already has this order. */
  given: boolean;
}

/**
 * The fleets that could carry `move` (`A WAL - LON VIA`): every fleet, of any power, whose
 * legal orders include convoying that army to that province. These are the route the player
 * chooses from. Empty for anything but a move by convoy.
 */
export function carryingFleets(ctx: ComposeContext, move: string): CarryingFleet[] {
  const parsed = parseOrder(move);
  if (parsed?.type !== "move" || !parsed.via) return [];
  const order = (fleet: string) => `${fleet} C ${parsed.unit.unit} - ${provinceOf(parsed.dest)}`;
  const found: CarryingFleet[] = [];
  for (const [power, byUnit] of Object.entries(ctx.legal)) {
    for (const [unit, options] of Object.entries(byUnit)) {
      if (!unit.startsWith("F ")) continue;
      const text = order(unit);
      if (options.includes(text)) found.push({ power, unit, order: text, given: ctx.orders?.[power]?.[unit] === text });
    }
  }
  return found.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
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

/**
 * The same move by the other route, when both are legal: `A WAL - LON` and `A WAL - LON VIA`.
 * Null when the order is not a move or only one route exists.
 */
export function viaAlternative(ctx: ComposeContext, power: string, text: string): string | null {
  const parsed = parseOrder(text);
  if (parsed?.type !== "move") return null;
  const base = `${parsed.unit.unit} - ${parsed.dest}`;
  const other = parsed.via ? base : `${base} VIA`;
  return legalFor(ctx, power, parsed.unit.unit).includes(other) ? other : null;
}

/** How many more builds (or disbands) `power` may still write this adjustment phase. */
export function adjustmentsLeft(ctx: ComposeContext, power: string): number {
  const owed = Math.abs(ctx.allowance?.[power] ?? 0);
  return Math.max(0, owed - Object.keys(ctx.orders?.[power] ?? {}).length);
}

/** The first free `WAIVE:n` key, so removing an earlier order never makes two waives collide. */
export function nextWaiveKey(orders: Record<string, string>): string {
  let n = 0;
  while (`WAIVE:${n}` in orders) n++;
  return `WAIVE:${n}`;
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
  // The power the player is working on wins; only then anybody else with something to do here.
  const chosen = found.find((f) => f.power === ctx.active) ?? found[0];
  if (!chosen) return say(draft, `No build or disband is possible in ${province}.`);
  return adjustmentStep(ctx, draft, chosen.power, province, chosen.options);
}

/** A build or disband in `province`, capped at what `power` is owed; a menu when there is a choice. */
function adjustmentStep(ctx: ComposeContext, draft: Draft, power: string, province: string, options: string[]): Step {
  const isDisband = parseOrder(options[0]!)?.type === "disband";
  const key = `${isDisband ? "D" : "B"}:${province}`;
  // Changing an order already written for this province is always allowed; a new one must fit the allowance.
  const replacing = key in (ctx.orders?.[power] ?? {});
  if (ctx.allowance && !replacing && adjustmentsLeft(ctx, power) === 0) {
    const owed = Math.abs(ctx.allowance[power] ?? 0);
    const noun = `${owed} ${owed === 1 ? "unit" : "units"}`;
    return say(
      draft,
      isDisband
        ? `${titleCase(power)} only has to disband ${noun}. Remove an order to choose a different one.`
        : `${titleCase(power)} may only build ${noun}. Remove an order to choose a different one.`,
    );
  }
  if (options.length === 1) return orderStep(power, key, options[0]!);
  return {
    draft: IDLE,
    effect: { kind: "choose", power, key, title: `${isDisband ? "Disband" : "Build"} in ${province}`, options },
  };
}

/**
 * An order typed in MILA (already made canonical by the engine) for `power`, checked against the
 * same legal list the map uses, and keyed the way a click would key it. A move typed without
 * `VIA` that only a convoy could make is written as the convoy. Never composes an order the map
 * could not.
 */
export function typedOrder(ctx: ComposeContext, power: string, text: string): Step {
  const parsed = parseOrder(text);
  if (!parsed) return say(IDLE, `${text} is not an order Cabal can read.`);
  if (ctx.phase === "A") {
    if (parsed.type === "waive") {
      if ((ctx.allowance?.[power] ?? 0) <= 0) return say(IDLE, `${titleCase(power)} has no build to waive.`);
      if (adjustmentsLeft(ctx, power) === 0) {
        return say(IDLE, `${titleCase(power)} has written every build it is owed. Remove one to waive it.`);
      }
      return orderStep(power, nextWaiveKey(ctx.orders?.[power] ?? {}), "WAIVE");
    }
    if (parsed.type !== "build" && parsed.type !== "disband") {
      return say(IDLE, "Only builds, disbands and waives are ordered in winter.");
    }
    if (!(ctx.legal[power]?.[""] ?? []).includes(text)) return say(IDLE, `${text} is not a legal order this phase.`);
    return adjustmentStep(ctx, IDLE, power, parsed.unit.province, [text]);
  }
  if (parsed.type === "waive") return say(IDLE, "Builds are only waived in winter.");
  const unit = Object.keys(ctx.legal[power] ?? {}).find((u) => u && parseUnit(u)?.province === parsed.unit.province);
  if (!unit) {
    return say(IDLE, ctx.phase === "R" ? `${parsed.unit.unit} has no retreat to make.` : `${parsed.unit.unit} cannot be ordered.`);
  }
  const written = forUnit(text, unit);
  const options = legalFor(ctx, power, unit);
  const match = options.find((o) => o === written) ?? options.find((o) => o === `${written} VIA`);
  return match ? orderStep(power, unit, match) : say(IDLE, `${written} is not a legal order this phase.`);
}
