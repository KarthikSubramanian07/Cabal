/**
 * GameIndex: the one port through which the server reads and writes its cross-game index.
 *
 * Everything outside this file talks to the index through this interface: rooms record finished
 * games, keep their public listing fresh and note the seats signed-in players take; the router
 * lists games and checks health. In production the adapter is D1 (d1-index.ts, database `cabal`).
 * Where no D1 database is bound the Registry Durable Object serves the games half, as it did
 * before D1, and there are no players. The schema lives in plain SQL files under
 * `apps/server/migrations/`, valid for both.
 *
 * Players, ratings and the trust ledger have their own port, `PlayerStore`, which only D1 serves.
 */
import type { GameListing, GameRecord, GameResult, PowerName } from "@cabal/protocol";
import { D1Index, type PlayerStore } from "./d1-index.js";
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

/** A signed-in player has taken a seat: the start of one stint. */
export interface SeatClaim {
  gameId: string;
  power: PowerName;
  stint: number;
  playerId: string;
  name: string;
  joinedAt: number;
  substitute: boolean;
}

export interface GameIndex {
  /** Index a finished or abandoned game, public or not, and drop its live listing. Idempotent. */
  recordGame(record: GameRecord): Promise<void>;
  /** One recorded game by its code, whatever its visibility. Never exposed as a list. */
  getGame(gameId: string): Promise<GameRecord | null>;
  /** The public list: ended games that were created as public and played at least one phase. */
  listGames(options?: ListFinished): Promise<GameRecord[]>;
  /** Insert or refresh a public game's listing. */
  upsertListing(listing: GameListing): Promise<void>;
  removeListing(gameId: string): Promise<void>;
  listListings(options: ListLive): Promise<GameListing[]>;
  /** Note a signed-in player's seat, so their own games list shows it while it runs. Idempotent. */
  recordSeat(claim: SeatClaim): Promise<void>;
  /** Highest migration applied; also the health probe. */
  schemaVersion(): Promise<number>;
  /**
   * Ask for a game's place under the deployment-wide Claude budget, for the whole of its spend
   * cap. Must be atomic: two games asking at once may not both take the last place. Idempotent.
   */
  admitClaudeGame(request: { gameId: string; capMicros: number; now: number }): Promise<{ admitted: boolean; reason: string | null }>;
  /** A Claude game has ended: free its place and record what it spent. Idempotent. */
  releaseClaudeGame(request: { gameId: string; spentMicros: number; now: number }): Promise<void>;
}

const registryStub = (env: Env) => (env.REGISTRY ? () => env.REGISTRY!.get(env.REGISTRY!.idFromName(REGISTRY_NAME)) : null);

/** The Registry as a games index: what served before D1, and what serves where no D1 is bound. */
function registryIndex(stub: NonNullable<ReturnType<typeof registryStub>>): GameIndex {
  return {
    recordGame: async (record) => void (await stub().recordGame(record)),
    getGame: async (gameId) => stub().getGame(gameId),
    listGames: async (options = {}) => stub().listGames(options),
    upsertListing: async (listing) => void (await stub().upsertListing(listing)),
    removeListing: async (gameId) => void (await stub().removeListing(gameId)),
    listListings: async (options) => stub().listListings(options),
    // The Registry has no players.
    recordSeat: async () => undefined,
    schemaVersion: async () => stub().schemaVersion(),
    admitClaudeGame: async (request) => stub().admitClaudeGame(request),
    releaseClaudeGame: async (request) => void (await stub().releaseClaudeGame(request)),
  };
}

/** Which store serves the index in this deployment. */
/**
 * The D1 schema this build needs: the number of the newest file in migrations/ (a test pins it).
 * `/health` is not ok, and answers 503, while the bound database is behind it, so a build deployed
 * before its migrations were applied is caught by the first health check.
 */
export const D1_SCHEMA_REQUIRED = 12;

export function indexBackend(env: Env): "d1" | "registry" | "none" {
  return env.DB ? "d1" : env.REGISTRY ? "registry" : "none";
}

/** The D1 adapter, or null when no database is bound. */
export function d1Index(env: Env): D1Index | null {
  return env.DB ? new D1Index(env.DB, registryStub(env)) : null;
}

/** The index for this deployment, or null when none is bound (some tests, bare local dev). */
export function gameIndex(env: Env): GameIndex | null {
  const d1 = d1Index(env);
  if (d1) return d1;
  const stub = registryStub(env);
  return stub ? registryIndex(stub) : null;
}

/** Players, ratings and the ledger: D1 only. */
export function playerStore(env: Env): PlayerStore | null {
  return d1Index(env);
}

/** The Registry's own schema version, for `/health`. */
export async function registrySchema(env: Env): Promise<number | null> {
  const stub = registryStub(env);
  return stub ? stub().schemaVersion() : null;
}

let copying: Promise<unknown> | null = null;

/**
 * Copy the Registry's games index into D1, once per deployment (and at most one attempt per
 * isolate at a time). Safe to call on every request: after the first success it is one D1 read
 * per isolate. A failure is logged by the caller and retried by the next isolate or request.
 */
export function copyRegistryOnce(env: Env): Promise<unknown> | null {
  const d1 = d1Index(env);
  const stub = registryStub(env);
  if (!d1 || !stub) return null;
  copying ??= d1.copyFromRegistry(stub()).catch((error) => {
    copying = null;
    throw error;
  });
  return copying;
}
