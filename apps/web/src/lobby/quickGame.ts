/**
 * Play now: one human, six bots, started at once. An unlisted live table (ten minutes a move,
 * and a phase resolves the moment the player readies, since the bots are ready at once), with
 * full press so the bots' table talk can be read. Built on the same calls as any table: create
 * as the signed-in player, keep the seat on the device, start.
 */
import type { GameSettingsInput } from "@cabal/protocol";
import { loadApi } from "../net/lazy.js";
import type { StoredPlayer } from "../net/player.js";

export const QUICK_SETTINGS: GameSettingsInput = {
  pacing: "live",
  press: "full",
  aiFill: true,
  aiBrain: "bot",
  visibility: "unlisted",
};

/** Set the table, sit down and start it. Resolves with the table's code. */
export async function startQuickGame(player: StoredPlayer): Promise<string> {
  const [{ api }, { keepCreatedSeat }] = await Promise.all([loadApi(), import("./useRoom.js")]);
  const res = await api.createGame({ settings: QUICK_SETTINGS }, player.secret);
  keepCreatedSeat({ gameId: res.gameId, power: res.power, token: res.token, name: player.handle, userId: player.id });
  await api.startGame(res.gameId, res.token);
  return res.gameId;
}
