/**
 * The phase log of a game read back from its saved file, for an arena that did not referee the
 * game itself (one played through a real server). The engine replays the file: each phase's
 * outcome comes from `Game.outcome`, the units each power had to order from the position before
 * it, and the receipts from the pledges the file carries. For a game the local arena played, this
 * gives exactly the log the arena kept while playing (a test holds the two together).
 */
import { Game, type State } from "@cabal/engine";
import { phaseKind } from "../prompt.js";
import type { PhaseLog } from "./local.js";

/** A pledge as a saved game or the room's ledger lists it. Entries without a receipt are skipped. */
export interface SavedPledge {
  id?: string;
  phase: string;
  pledger: string;
  audience: string;
  receipt?: string | null;
}

interface SavedFile {
  phases: { name: string; state: State; orders?: Record<string, string[]> }[];
  cabal?: { pledges?: SavedPledge[] };
}

const RECEIPTS = new Set(["kept", "broken", "void"]);

/**
 * One `PhaseLog` per resolved phase of `saved`. `pledges` overrides the file's own list, for a
 * server that shows each seat only the pledges it may read: pass the union of what every seat saw.
 */
export function phaseLogs(saved: string, pledges?: SavedPledge[]): PhaseLog[] {
  const file = JSON.parse(saved) as SavedFile;
  const all = pledges ?? file.cabal?.pledges ?? [];
  const game = Game.fromSaved(saved);
  const logs: PhaseLog[] = [];
  try {
    const resolved = game.historyLength();
    for (let index = 0; index < resolved; index++) {
      const phase = file.phases[index]!;
      const outcome = game.outcome(index);
      const before = Game.fromState(phase.state, game.rulebook());
      let legal: ReturnType<Game["legalAll"]>;
      try {
        legal = before.legalAll();
      } finally {
        before.free();
      }
      const kind = phaseKind(phase.name);
      const units: Record<string, number> = {};
      for (const [power, menu] of Object.entries(legal)) {
        units[power] = kind === "A" ? menu.allowance : Object.values(menu.by_unit).filter((o) => o.length > 0).length;
      }
      const centres: Record<string, number> = {};
      for (const [power, list] of Object.entries(outcome.next.centers)) centres[power] = list.length;
      const seen = new Set<string>();
      const receipts: PhaseLog["pledges"] = [];
      for (const p of all) {
        if (p.phase !== phase.name || !p.receipt || !RECEIPTS.has(p.receipt)) continue;
        if (p.id !== undefined) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
        }
        receipts.push({ pledger: p.pledger, audience: p.audience, receipt: p.receipt as "kept" | "broken" | "void" });
      }
      logs.push({
        phase: phase.name,
        submitted: Object.fromEntries(Object.entries(phase.orders ?? {}).filter(([, orders]) => orders.length > 0)),
        units,
        illegal: outcome.results.filter((r) => r.code === "illegal").length,
        rejected: outcome.rejected?.length ?? 0,
        pledges: receipts,
        centres,
      });
    }
  } finally {
    game.free();
  }
  return logs;
}
