/**
 * Orders written as text, MILA style (`A PAR - BUR`, `F NTH C A LON - NWY`): what to suggest
 * while the player types, and which power a typed order belongs to. The engine makes the
 * text canonical and judges it; this module only ranks and routes. Pure, so it is unit tested.
 */

/** Words and arrows players type, in the short forms orders are written with. */
const WORDS: Record<string, string> = {
  HOLD: "H",
  HOLDS: "H",
  SUPPORT: "S",
  SUPPORTS: "S",
  CONVOY: "C",
  CONVOYS: "C",
  RETREAT: "R",
  RETREATS: "R",
  BUILD: "B",
  BUILDS: "B",
  DISBAND: "D",
  DISBANDS: "D",
  ARMY: "A",
  FLEET: "F",
  TO: "-",
};

/** Upper case, arrows as `-`, words as their letters, one space between words. */
export function normaliseTyped(input: string): string {
  return input
    .toUpperCase()
    .replace(/->|→|–|—|=>/g, " - ")
    .replace(/(?<=[A-Z])-(?=[A-Z])/g, " - ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORDS[w] ?? w)
    .join(" ");
}

/** Several orders in one go: separated by `;`, `,` or new lines. */
export function splitTyped(input: string): string[] {
  return input
    .split(/[;\n\r,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Suggestion {
  power: string;
  text: string;
}

/**
 * Legal orders that fit what has been typed, best first, at most `limit`. An order fits when
 * every typed word starts a word of it, in the same order (`par bur` fits `A PAR - BUR`).
 * Orders that begin with exactly what was typed come first, then the active power's, then the
 * shorter (a hold before a support), then alphabetical.
 */
export function suggest(input: string, legal: readonly Suggestion[], active: string, limit = 8): Suggestion[] {
  const typed = normaliseTyped(input);
  if (!typed) return [];
  const words = typed.split(" ");
  const ranked: { s: Suggestion; score: number }[] = [];
  for (const s of legal) {
    if (s.text.startsWith(typed)) {
      ranked.push({ s, score: 0 });
      continue;
    }
    const parts = s.text.split(" ");
    let at = 0;
    for (const part of parts) {
      if (at < words.length && part.startsWith(words[at]!)) at++;
    }
    if (at === words.length) ranked.push({ s, score: 1 });
  }
  return ranked
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(b.s.power === active) - Number(a.s.power === active) ||
        a.s.text.length - b.s.text.length ||
        (a.s.text < b.s.text ? -1 : a.s.text > b.s.text ? 1 : 0),
    )
    .slice(0, limit)
    .map((r) => r.s);
}

/** The engine's judgement of one order for one power (`validateOrders`). */
export interface Verdict {
  canonical: string | null;
  legal: boolean;
  code: string;
  reason: string;
}

/**
 * The power a typed order is for: the active power if the order is legal for it, otherwise
 * the first power it is legal for. When it is legal for nobody, the verdict worth showing:
 * the owner's if the unit belongs to someone (its reason is about the order, not ownership),
 * else the active power's.
 */
export function routeTyped(
  judge: (power: string) => Verdict,
  active: string,
  powers: readonly string[],
): { power: string; verdict: Verdict } {
  const order = [active, ...powers.filter((p) => p !== active)];
  const verdicts = order.map((power) => ({ power, verdict: judge(power) }));
  const legal = verdicts.find((v) => v.verdict.legal);
  if (legal) return legal;
  const owner = verdicts.find((v) => !OWNERSHIP.has(v.verdict.code));
  return owner ?? verdicts[0]!;
}

/** Codes that only say the order is for somebody else's unit or phase. */
const OWNERSHIP = new Set(["foreign_unit", "no_unit", "nothing_to_do", "not_owned", "wrong_power", "not_dislodged"]);
