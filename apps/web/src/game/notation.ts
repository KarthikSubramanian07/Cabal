/**
 * Reading MILA order text. The engine produces every order the client shows,
 * so these helpers only need to understand canonical text.
 */

export type PhaseKind = "M" | "R" | "A";

export const POWER_NAMES = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"] as const;
export type PowerName = (typeof POWER_NAMES)[number];

export function phaseKind(phase: string): PhaseKind {
  const k = phase.at(-1);
  return k === "R" ? "R" : k === "A" ? "A" : "M";
}

const SEASONS: Record<string, string> = { S: "Spring", F: "Fall", W: "Winter" };
const KINDS: Record<string, string> = { M: "Movement", R: "Retreats", A: "Adjustments" };

/** `S1901M` -> `Spring 1901`, `Movement` */
export function describePhase(phase: string): { season: string; year: string; kind: string } {
  if (phase === "COMPLETED") return { season: "Game over", year: "", kind: "" };
  return {
    season: SEASONS[phase[0] ?? ""] ?? phase,
    year: phase.slice(1, 5),
    kind: KINDS[phase.at(-1) ?? ""] ?? "",
  };
}

export function titleCase(power: string): string {
  return power.charAt(0) + power.slice(1).toLowerCase();
}

export interface UnitRef {
  /** `A PAR`, `F STP/NC` */
  unit: string;
  kind: "A" | "F";
  /** `PAR`, `STP/NC` */
  region: string;
  /** `PAR`, `STP` */
  province: string;
}

const UNIT = /^\*?([AF]) ([A-Z]{3}(?:\/[NSEW]C)?)/;

export function parseUnit(text: string): UnitRef | null {
  const m = UNIT.exec(text.trim());
  if (!m) return null;
  const region = m[2]!;
  return { unit: `${m[1]} ${region}`, kind: m[1] as "A" | "F", region, province: region.slice(0, 3) };
}

export type ParsedOrder =
  | { type: "hold"; unit: UnitRef }
  | { type: "move"; unit: UnitRef; dest: string; via: boolean }
  | { type: "support-hold"; unit: UnitRef; target: UnitRef }
  | { type: "support-move"; unit: UnitRef; target: UnitRef; dest: string }
  | { type: "convoy"; unit: UnitRef; army: UnitRef; dest: string }
  | { type: "retreat"; unit: UnitRef; dest: string }
  | { type: "disband"; unit: UnitRef }
  | { type: "build"; unit: UnitRef }
  | { type: "waive" };

/** Parse canonical MILA order text. Returns null for anything else. */
export function parseOrder(text: string): ParsedOrder | null {
  const t = text.trim().toUpperCase();
  if (t === "WAIVE") return { type: "waive" };
  const unit = parseUnit(t);
  if (!unit) return null;
  const rest = t.slice(unit.unit.length).trim().split(/\s+/);
  const [verb, ...args] = rest;
  switch (verb) {
    case undefined:
    case "":
    case "H":
      return { type: "hold", unit };
    case "-":
      return args[0] ? { type: "move", unit, dest: args[0], via: args[1] === "VIA" } : null;
    case "R":
      return args[0] ? { type: "retreat", unit, dest: args[0] } : null;
    case "D":
      return { type: "disband", unit };
    case "B":
      return { type: "build", unit };
    case "S": {
      const target = parseUnit(args.slice(0, 2).join(" "));
      if (!target) return null;
      if (args[2] === "-" && args[3]) return { type: "support-move", unit, target, dest: args[3] };
      return { type: "support-hold", unit, target };
    }
    case "C": {
      const army = parseUnit(args.slice(0, 2).join(" "));
      if (!army || args[2] !== "-" || !args[3]) return null;
      return { type: "convoy", unit, army, dest: args[3] };
    }
    default:
      return null;
  }
}

/** Province code of a region (`STP/NC` -> `STP`). */
export function provinceOf(region: string): string {
  return region.slice(0, 3);
}
