/**
 * The arena, in process: seven `Player`s at one table, the engine as the referee, no server and
 * no network. This is what the smoke test and the nightly evaluation run. `server.ts` plays the
 * same seats through a real `cabal-server` instead.
 *
 * A movement phase is played the way `AgentClient` plays it against a room: every seat opens with
 * a negotiate step (press and at most one pledge), all of that press is delivered, then every seat
 * gives its final orders having read it. Retreats and builds are one step. Pledges are checked by
 * the engine when they are made, judged by it when the phase resolves, and saved in the game with
 * their receipts; the receipts feed every seat's trust ledger, as the room's do.
 */
import { Game, type MapInfo, mapInfo, pledgeCommit } from "@cabal/engine";
import { unitInterval } from "../bot-brain.js";
import type { Played, Player } from "../player.js";
import { yearOf } from "../player.js";
import { outgoingPress } from "../press.js";
import { phaseKind } from "../prompt.js";
import { type DecisionRecord, decisionRecord } from "../record.js";

export type PressMode = "full" | "public" | "gunboat";

export interface LocalArenaOptions {
  gameId: string;
  /** One player per power. Powers without a player hold every unit (civil disorder). */
  players: Player[];
  /** Play to the end of this year (the winter adjustments of `untilYear`), or to a solo. */
  untilYear: number;
  press?: PressMode;
  /** False plays every phase in one step, without the opening round of press. Default true. */
  negotiate?: boolean;
  onRecord?: (record: DecisionRecord) => void;
  /** Called after each phase is adjudicated. */
  onPhase?: (log: PhaseLog) => void;
}

/** What happened in one phase, for the summary. */
export interface PhaseLog {
  phase: string;
  /** Orders each power submitted. */
  submitted: Record<string, string[]>;
  /** Units each power had to order (movement and retreat phases), or its allowance (adjustments). */
  units: Record<string, number>;
  /** Orders the engine adjudicated as illegal, and orders it could not adjudicate at all. */
  illegal: number;
  rejected: number;
  pledges: { pledger: string; audience: string; receipt: "kept" | "broken" | "void" }[];
  /** Supply centres per power once the phase resolved. */
  centres: Record<string, number>;
}

export interface ArenaGame {
  gameId: string;
  /** The MILA saved game, as `Game.toSaved` writes it: press, pledges and receipts included. */
  saved: string;
  records: DecisionRecord[];
  phases: PhaseLog[];
  /** `active` (stopped at the year limit), `solo:POWER` or `draw`. */
  status: string;
  elapsedMs: number;
}

interface Tabled {
  id: string;
  phase: string;
  from: string;
  to: string;
  body: string;
  pledge: { orders: string[]; sealed: boolean } | null;
}

/** A nonce that is the same for the same pledge in the same game, so a saved arena game is reproducible. */
function nonceFor(seed: string): string {
  let hex = "";
  for (let i = 0; hex.length < 32; i++) hex += Math.floor(unitInterval(`${seed}|${i}`) * 2 ** 32).toString(16).padStart(8, "0");
  return hex.slice(0, 32);
}

export async function runLocalArena(opts: LocalArenaOptions): Promise<ArenaGame> {
  const started = Date.now();
  const mode: PressMode = opts.press ?? "full";
  const map: MapInfo = mapInfo();
  const game = new Game();
  const press: Tabled[] = [];
  const trust: Record<string, { kept: number; broken: number }> = {};
  const records: DecisionRecord[] = [];
  const phases: PhaseLog[] = [];
  let clock = 0;
  try {
    while (game.status() === "active") {
      const phase = game.phase();
      const year = yearOf(phase);
      if (year === null || year > opts.untilYear) break;
      const state = game.state();
      const legal = game.legalAll();
      const kind = phaseKind(phase);
      const seated = opts.players.filter((p) => {
        const menu = legal[p.power];
        if (!menu) return false;
        return kind === "A" ? menu.allowance !== 0 : Object.values(menu.by_unit).some((orders) => orders.length > 0);
      });

      const view = (power: string) => ({
        press: press
          .filter((m) => m.phase === phase && (m.to === power || m.to === "ALL" || m.from === power))
          .map((m) => ({ from: m.from, to: m.to, body: m.body, pledge: m.pledge && (!m.pledge.sealed || m.from === power) ? m.pledge.orders : null })),
        earlierPress: press
          .filter((m) => m.phase !== phase && (m.from === power || m.to === power))
          .map((m) => ({ phase: m.phase, from: m.from, to: m.to, body: m.body })),
        myPledges: press.filter((m) => m.phase === phase && m.from === power && m.pledge).map((m) => m.pledge!.orders),
        trust: structuredClone(trust),
      });

      const table = (power: string, played: Played) => {
        for (const out of outgoingPress(played, power, mode)) {
          const id = `${phase}-${++clock}`;
          game.recordMessage({ sender: power, recipient: out.to, phase, time_sent: clock, message: out.body });
          let pledge: Tabled["pledge"] = null;
          if (out.pledge) {
            try {
              pledge = { orders: game.pledgeCheck(power, out.pledge.orders), sealed: out.pledge.sealed };
            } catch {
              pledge = null; // the room refuses such a pledge and the message goes without it
            }
          }
          if (pledge) {
            const nonce = nonceFor(`${opts.gameId}|${id}`);
            game.recordPledge({
              id,
              phase,
              pledger: power,
              audience: out.to,
              sealed: pledge.sealed,
              orders: pledge.orders,
              ...(pledge.sealed ? { commitment: pledgeCommit(pledge.orders, nonce), nonce } : {}),
            });
          }
          press.push({ id, phase, from: power, to: out.to, body: out.body, pledge });
        }
      };

      const play = async (step: "negotiate" | "order") => {
        const played = await Promise.all(
          seated.map((p) => p.play({ phase, step, state, map, legal: legal[p.power]!, ...view(p.power) })),
        );
        played.forEach((turn, i) => {
          const power = seated[i]!.power;
          const record = decisionRecord(phase, power, turn);
          records.push(record);
          opts.onRecord?.(record);
        });
        // Delivered after everybody has spoken: nobody reads a message sent in the same breath.
        played.forEach((turn, i) => table(seated[i]!.power, turn));
        return played;
      };

      if (kind === "M" && mode !== "gunboat" && opts.negotiate !== false) await play("negotiate");
      const finals = await play("order");
      const submitted: Record<string, string[]> = {};
      finals.forEach((turn, i) => (submitted[seated[i]!.power] = turn.validated.orders));

      const outcome = game.process({ orders: submitted });
      const index = game.historyLength() - 1;
      const receipts: PhaseLog["pledges"] = [];
      for (const m of press.filter((x) => x.phase === phase && x.pledge)) {
        const receipt = game.pledgeReceipt(index, m.from, m.pledge!.orders, submitted[m.from] ?? []) as "kept" | "broken" | "void";
        const nonce = nonceFor(`${opts.gameId}|${m.id}`);
        game.recordPledge({
          id: m.id,
          phase,
          pledger: m.from,
          audience: m.to,
          sealed: m.pledge!.sealed,
          orders: m.pledge!.orders,
          ...(m.pledge!.sealed ? { commitment: pledgeCommit(m.pledge!.orders, nonce), nonce } : {}),
          receipt,
        });
        receipts.push({ pledger: m.from, audience: m.to, receipt });
        const t = (trust[m.from] ??= { kept: 0, broken: 0 });
        if (receipt === "kept") t.kept++;
        if (receipt === "broken") t.broken++;
      }
      const units: Record<string, number> = {};
      for (const [power, menu] of Object.entries(legal)) {
        units[power] = kind === "A" ? menu.allowance : Object.values(menu.by_unit).filter((o) => o.length > 0).length;
      }
      const centres: Record<string, number> = {};
      for (const [power, list] of Object.entries(outcome.next.centers)) centres[power] = list.length;
      const log: PhaseLog = {
        phase,
        submitted,
        units,
        illegal: outcome.results.filter((r) => r.code === "illegal").length,
        rejected: outcome.rejected?.length ?? 0,
        pledges: receipts,
        centres,
      };
      phases.push(log);
      opts.onPhase?.(log);
    }
    return { gameId: opts.gameId, saved: game.toSaved(opts.gameId), records, phases, status: game.status(), elapsedMs: Date.now() - started };
  } finally {
    game.free();
  }
}
