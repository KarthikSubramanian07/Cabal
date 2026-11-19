/**
 * The built-in bot: the brain behind every AI seat unless a game opts into Claude, the cover for
 * seats in civil disorder, and the fallback whenever a Claude turn is late, fails or is over budget.
 *
 * It runs inside the GameRoom, costs nothing and answers at once, so an AI seat can never hold a
 * phase up. Orders are picked from the engine's own legal menu and are deterministic for a given
 * game, phase and power, which keeps replays and tests reproducible.
 *
 * This is the single seam for the Rust heuristic bot (`botOrders` from `@cabal/engine`): when that
 * export lands, `botOrders` below becomes a one-line call to it and nothing else in the room changes.
 */
import type { Game } from "./engine.js";
import { mapInfo } from "./engine.js";

/** FNV-1a, folded into a small xorshift generator: stable across isolates and runs. */
function seeded(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let x = h | 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

let centres: Set<string> | undefined;
function supplyCentres(): Set<string> {
  centres ??= new Set(mapInfo().provinces.filter((p) => p.supply_center !== null).map((p) => p.id));
  return centres;
}

/** `A PAR - BUR` or `F MAO - SPA/SC` -> `BUR`, `SPA`; anything else -> null. */
function destination(order: string): string | null {
  const m = /^[AF] \S+ - ([A-Z]{3})(?:\/[A-Z]{2})?(?: VIA)?$/.exec(order);
  return m ? m[1]! : null;
}

function movement(game: Game, power: string, random: () => number): string[] {
  const menu = game.legal(power).by_unit;
  const mine = new Set(game.state().centers[power] ?? []);
  const taken = new Set<string>();
  const orders: string[] = [];
  // A fixed unit order keeps the choice independent of object key order.
  for (const unit of Object.keys(menu).sort()) {
    const options = menu[unit] ?? [];
    const moves = options
      .map((order) => ({ order, to: destination(order) }))
      .filter((m): m is { order: string; to: string } => m.to !== null && !taken.has(m.to));
    const captures = moves.filter((m) => supplyCentres().has(m.to) && !mine.has(m.to));
    const pool = captures.length > 0 ? captures : moves;
    // Three times in four a unit with somewhere to go goes there; otherwise it holds its ground.
    const pick = pool.length > 0 && (captures.length > 0 || random() < 0.75) ? pool[Math.floor(random() * pool.length)]! : null;
    if (pick) {
      taken.add(pick.to);
      orders.push(pick.order);
    } else {
      const hold = options.find((order) => order.endsWith(" H"));
      if (hold) orders.push(hold);
    }
  }
  return orders;
}

function retreats(game: Game, power: string, random: () => number): string[] {
  const menu = game.legal(power).by_unit;
  const taken = new Set<string>();
  const orders: string[] = [];
  for (const unit of Object.keys(menu).sort()) {
    const options = menu[unit] ?? [];
    const open = options.filter((order) => {
      const m = / R ([A-Z]{3})/.exec(order);
      return m !== null && !taken.has(m[1]!);
    });
    const pick = open[Math.floor(random() * open.length)] ?? options.find((order) => order.endsWith(" D"));
    if (!pick) continue;
    const to = / R ([A-Z]{3})/.exec(pick)?.[1];
    if (to) taken.add(to);
    orders.push(pick);
  }
  return orders;
}

function adjustments(game: Game, power: string, random: () => number): string[] {
  const legal = game.legal(power);
  const options = Object.values(legal.by_unit).flat();
  const wanted = Math.abs(legal.allowance);
  const building = legal.allowance > 0;
  const pool = options.filter((order) => (building ? order.endsWith(" B") : order.endsWith(" D")));
  const used = new Set<string>();
  const orders: string[] = [];
  while (orders.length < wanted && pool.length > 0) {
    const [pick] = pool.splice(Math.floor(random() * pool.length), 1);
    // One build per home centre, one disband per unit.
    const province = /^[AF] ([A-Z]{3})/.exec(pick!)?.[1];
    if (!province || used.has(province)) continue;
    used.add(province);
    orders.push(pick!);
  }
  return orders;
}

/** Legal orders for `power` in the game's current phase. Empty when the power has nothing to order. */
export function botOrders(game: Game, power: string, seed: string): string[] {
  const phase = game.phase();
  const random = seeded(`${seed}:${phase}:${power}`);
  if (phase.endsWith("R")) return retreats(game, power, random);
  if (phase.endsWith("A")) return adjustments(game, power, random);
  return movement(game, power, random);
}

/** True when the power has at least one order to give this phase. */
export function canAct(game: Game, power: string): boolean {
  const legal = game.legal(power);
  if (game.phase().endsWith("A")) return legal.allowance !== 0;
  return Object.values(legal.by_unit).some((options) => options.length > 0);
}
