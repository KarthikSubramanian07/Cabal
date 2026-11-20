/**
 * The arena through a real `cabal-server` (usually `wrangler dev` on this machine): the seven
 * seats create and join a game over HTTP like any lobby, then play it as `AgentClient`s over the
 * human WebSocket protocol, with nothing the server would not give a person. When the year limit
 * is reached the arena stops listening, reads the saved game back from the replay route with
 * every seat's token (each seat may read only the pledges it made or received), and hands the
 * same `ArenaGame` the in-process arena produces to `summarise`.
 */
import type { CreateGameResponse, GameSummary, LedgerEntry } from "@cabal/protocol";
import { AgentClient } from "../client.js";
import type { Player } from "../player.js";
import { yearOf } from "../player.js";
import type { DecisionRecord } from "../record.js";
import type { ArenaGame, PhaseLog, PressMode } from "./local.js";
import { phaseLogs } from "./saved.js";

export interface ServerArenaOptions {
  /** The server's origin, e.g. `http://localhost:8787`. */
  serverUrl: string;
  /** Seven players, one per power. */
  players: Player[];
  /** Stop once every phase of this year has resolved. */
  untilYear: number;
  press?: PressMode;
  negotiate?: boolean;
  /** How long a seat listens between its press and its final orders. Default 250 ms. */
  listenMs?: number;
  /** Give up after this long. Default 15 minutes. */
  timeoutMs?: number;
  /** How often to look at the game's phase. Default 250 ms. */
  pollMs?: number;
  onRecord?: (record: DecisionRecord) => void;
  onPhase?: (log: PhaseLog) => void;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

interface Seat {
  player: Player;
  token: string;
}

export async function runServerArena(opts: ServerArenaOptions): Promise<ArenaGame> {
  const started = Date.now();
  const http = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, "");
  const call = async <T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await http(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };
  const byPower = new Map(opts.players.map((p) => [p.power, p]));
  if (byPower.size !== opts.players.length) throw new Error("one player per power");

  const settings = { press: opts.press ?? "full", pacing: "live", aiFill: false, visibility: "unlisted", readyAdvance: true };
  const created = await call<CreateGameResponse>("/api/games", {
    method: "POST",
    body: JSON.stringify({ name: "Arena host", settings }),
  });
  const gameId = created.gameId;
  const host = byPower.get(created.power);
  if (!host) throw new Error(`the server seated the host as ${created.power}, which has no player`);
  const seats: Seat[] = [{ player: host, token: created.token }];
  for (const player of opts.players) {
    if (player === host) continue;
    const joined = await call<CreateGameResponse>(`/api/games/${gameId}/join`, {
      method: "POST",
      body: JSON.stringify({ name: `Arena ${player.power.toLowerCase()}`, power: player.power }),
    });
    if (joined.power !== player.power) throw new Error(`asked for ${player.power}, seated as ${joined.power}`);
    seats.push({ player, token: joined.token });
  }
  // A room starts by itself once every seat is taken; start it only if it is still waiting.
  const lobby = await call<GameSummary>(`/api/games/${gameId}`);
  if (lobby.status === "lobby") await call(`/api/games/${gameId}/start`, { method: "POST", token: created.token });

  const records: DecisionRecord[] = [];
  const clients = seats.map(
    (seat) =>
      new AgentClient({
        serverUrl: base,
        gameId,
        token: seat.token,
        player: seat.player,
        negotiate: opts.negotiate ?? true,
        listenMs: opts.listenMs ?? 250,
        lastYear: opts.untilYear,
        ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
        onDecision: (record) => {
          records.push(record);
          opts.onRecord?.(record);
        },
      }),
  );
  let summary: GameSummary;
  try {
    await Promise.all(clients.map((c) => c.connect()));
    const deadline = started + (opts.timeoutMs ?? 15 * 60_000);
    for (;;) {
      summary = await call<GameSummary>(`/api/games/${gameId}`);
      const year = yearOf(summary.phase);
      if (summary.status !== "active" && summary.status !== "lobby") break;
      if (year === null || year > opts.untilYear) break;
      if (Date.now() > deadline) throw new Error(`game ${gameId} was still in ${summary.phase} after ${opts.timeoutMs ?? 15 * 60_000} ms`);
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
    }
  } finally {
    for (const c of clients) c.close();
  }

  // Each seat may read the pledges it made or received; together they are all of them.
  const replays = await Promise.all(
    seats.map((s) => call<{ cabal?: { pledges?: LedgerEntry[] } }>(`/api/games/${gameId}/replay`, { token: s.token })),
  );
  const pledges = replays.flatMap((r) => r.cabal?.pledges ?? []);
  const saved = JSON.stringify(replays[0]);
  const phases = phaseLogs(saved, pledges);
  for (const log of phases) opts.onPhase?.(log);
  const finished = summary.finished;
  const status = !finished
    ? "active"
    : finished.result === "solo"
      ? `solo:${finished.winners[0] ?? "?"}`
      : finished.result;
  // A seat may have begun the phase after the limit before the arena stopped listening.
  const played = records.filter((r) => (yearOf(r.phase) ?? Number.POSITIVE_INFINITY) <= opts.untilYear);
  return { gameId, saved, records: played, phases, status, elapsedMs: Date.now() - started };
}
