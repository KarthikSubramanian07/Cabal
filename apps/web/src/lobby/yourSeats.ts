/**
 * The seats to list under Your seats: the ones this browser holds, and, for a signed-in player,
 * every seat their account holds in a game still being played (taken on another device, or before
 * this browser's data was cleared). Opening one of those claims a token for this device.
 */
import type { MyGame, PowerName } from "@cabal/protocol";
import type { HeldSeat } from "../net/seats.js";

export interface ListedSeat {
  gameId: string;
  power: PowerName;
  /** The name the seat was taken under. */
  name: string;
  /** Held by the account but not yet by this browser. */
  elsewhere: boolean;
}

export function yourSeats(held: readonly HeldSeat[], account: readonly MyGame[] | null, handle: string | null): ListedSeat[] {
  const here: ListedSeat[] = held.map((s) => ({ gameId: s.gameId, power: s.power, name: s.name, elsewhere: false }));
  const known = new Set(here.map((s) => s.gameId));
  const there: ListedSeat[] = [];
  for (const g of account ?? []) {
    if (g.status !== "playing" || known.has(g.gameId)) continue;
    known.add(g.gameId);
    there.push({ gameId: g.gameId, power: g.power, name: handle ?? "", elsewhere: true });
  }
  return [...here, ...there];
}
