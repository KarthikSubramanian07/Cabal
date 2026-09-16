/** Parse canonical MILA order text into drawable geometry. */
import { type Anchor, anchorOf } from "./positions.js";

export type Drawable =
  | { kind: "hold"; at: Anchor }
  | { kind: "move"; from: Anchor; to: Anchor; via: boolean }
  | { kind: "support"; from: Anchor; to: Anchor }
  | { kind: "convoy"; from: Anchor; to: Anchor }
  | { kind: "retreat"; from: Anchor; to: Anchor }
  | { kind: "build"; at: Anchor }
  | { kind: "disband"; at: Anchor };

/** `A PAR - BUR` -> `{ unit: "A PAR", region: "PAR", kind: "A" }` */
export function unitOf(order: string): { unit: string; region: string; kind: "A" | "F" } | null {
  const m = /^([AF]) ([A-Z]{3}(?:\/[NSEW]C)?)/.exec(order.trim().toUpperCase());
  if (!m) return null;
  return { unit: `${m[1]} ${m[2]}`, region: m[2]!, kind: m[1] as "A" | "F" };
}

function mid(a: Anchor, b: Anchor): Anchor {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function drawable(order: string): Drawable | null {
  const t = order.trim().toUpperCase().split(/\s+/);
  const me = unitOf(order);
  if (!me) {
    if (t[0] === "WAIVE") return null;
    return null;
  }
  const from = anchorOf(me.region);
  const verb = t[2];
  if (!verb || verb === "H") return { kind: "hold", at: from };
  if (verb === "-") {
    const dest = t[3];
    if (!dest) return null;
    return { kind: "move", from, to: anchorOf(dest), via: t[4] === "VIA" };
  }
  if (verb === "R") {
    const dest = t[3];
    return dest ? { kind: "retreat", from, to: anchorOf(dest) } : null;
  }
  if (verb === "S") {
    // A PAR S A BUR - PIC  or  A WAL S F LON
    const target = t[4];
    if (!target) return null;
    const dash = t.indexOf("-", 4);
    if (dash > 0 && t[dash + 1]) {
      return { kind: "support", from, to: mid(anchorOf(target), anchorOf(t[dash + 1]!)) };
    }
    return { kind: "support", from, to: anchorOf(target) };
  }
  if (verb === "C") {
    const army = t[4];
    const dash = t.indexOf("-", 4);
    if (!army || dash < 0 || !t[dash + 1]) return null;
    return { kind: "convoy", from, to: mid(anchorOf(army), anchorOf(t[dash + 1]!)) };
  }
  if (verb === "B") return { kind: "build", at: from };
  if (verb === "D") return { kind: "disband", at: from };
  return null;
}

/** Province codes an order mentions (for tap-to-order matching). */
export function mentions(order: string): string[] {
  return (order.toUpperCase().match(/\b[A-Z]{3}(?:\/[NSEW]C)?\b/g) ?? [])
    .filter((w) => !["VIA"].includes(w))
    .map((w) => w.split("/")[0]!);
}
