/**
 * GameIndex: the one port through which the server reads and writes its cross-game index.
 *
 * Everything outside this file talks to the index through this interface: rooms record finished
 * games and keep their public listing fresh, the router lists games and checks health. Today the
 * only adapter is the `Registry` Durable Object (SQLite). The schema lives in plain SQL files under
 * `apps/server/migrations/`, written to be valid for D1 as well, so moving the index to D1 is a
 * second adapter and a binding, not a rewrite.
 */
import type { GameListing, GameRecord, GameResult } from "@cabal/protocol";
import type { Env } from "./env.js";
import { REGISTRY_NAME } from "./registry.js";

export interface ListFinished {
  limit?: number;
  /** Page by `finishedAt`: only games that ended before this instant. */
  before?: number;
  result?: GameResult;
}

export interface ListLive {
  /** `open`: public lobbies with a free seat. `active`: public games in play (running or paused). */
  status: "open" | "active";
  limit?: number;
  /** Page by `createdAt`: only games created before this instant. */
  before?: number;
  /** The caller's clock, so stale rows can be left out without the store needing one. */
  now: number;
}

export interface GameIndex {
  /** Index a finished or abandoned game and drop its live listing. Idempotent. */
  recordGame(record: GameRecord): Promise<void>;
  getGame(gameId: string): Promise<GameRecord | null>;
  listGames(options?: ListFinished): Promise<GameRecord[]>;
  /** Insert or refresh a public game's listing. */
  upsertListing(listing: GameListing): Promise<void>;
  removeListing(gameId: string): Promise<void>;
  listListings(options: ListLive): Promise<GameListing[]>;
  /** Highest migration applied; also the health probe. */
  schemaVersion(): Promise<number>;
}

/** The index for this deployment, or null when none is bound (some tests, bare local dev). */
export function gameIndex(env: Env): GameIndex | null {
  if (!env.REGISTRY) return null;
  const stub = () => env.REGISTRY!.get(env.REGISTRY!.idFromName(REGISTRY_NAME));
  return {
    recordGame: async (record) => void (await stub().recordGame(record)),
    getGame: async (gameId) => stub().getGame(gameId),
    listGames: async (options = {}) => stub().listGames(options),
    upsertListing: async (listing) => void (await stub().upsertListing(listing)),
    removeListing: async (gameId) => void (await stub().removeListing(gameId)),
    listListings: async (options) => stub().listListings(options),
    schemaVersion: async () => stub().schemaVersion(),
  };
}
