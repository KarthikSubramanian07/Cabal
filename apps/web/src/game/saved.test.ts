import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, type State, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrderBook } from "./book.js";
import { ImportError } from "./persist.js";
import { bookFromSaved, loadSaved, replay } from "./saved.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

/** Play order books from the opening position and return the game with what was written. */
function play(books: OrderBook[]) {
  const origin = new Game().state();
  const phases: { phase: string; orders: OrderBook }[] = [];
  let game = new Game();
  for (const orders of books) {
    phases.push({ phase: game.phase(), orders });
    game = replay(phases, origin).game;
  }
  return { json: game.toSaved("test"), written: books, game };
}

const given = (book: OrderBook) => Object.values(book).flatMap((o) => Object.values(o));

describe("loadSaved", () => {
  it("keeps only the orders that were written when it is told what they were", () => {
    const { json, written } = play([{ FRANCE: { "A PAR": "A PAR - BUR" } }]);
    // The saved game itself lists an order for all 22 units.
    const saved = JSON.parse(json) as { phases: { orders: Record<string, string[]> }[] };
    expect(Object.values(saved.phases[0]!.orders).flat()).toHaveLength(22);

    const { history, game } = loadSaved(json, written);
    expect(game.phase()).toBe("F1901M");
    expect(history).toHaveLength(1);
    expect(history[0]!.orders).toEqual({ FRANCE: { "A PAR": "A PAR - BUR" } });
    expect(history[0]!.outcome.results).toHaveLength(22);
  });

  it("keeps a hold that really was written", () => {
    const book = { FRANCE: { "A PAR": "A PAR - BUR", "F BRE": "F BRE H" } };
    const { json, written } = play([book]);
    expect(loadSaved(json, written).history[0]!.orders).toEqual(book);
  });

  it("without that record, leaves out the holds a unit makes without being told", () => {
    const { json } = play([{ FRANCE: { "A PAR": "A PAR - BUR", "F BRE": "F BRE H" } }]);
    const { history } = loadSaved(json);
    expect(given(history[0]!.orders)).toEqual(["A PAR - BUR"]);
  });

  it("gives the same game back when the fallback books are replayed", () => {
    const { json, game } = play([
      { FRANCE: { "A PAR": "A PAR - BUR" }, GERMANY: { "A MUN": "A MUN - BUR" }, ITALY: { "A VEN": "A VEN - TYR" } },
      { ITALY: { "A TYR": "A TYR - VIE" } },
    ]);
    const { history } = loadSaved(json);
    const again = replay(history, history[0]!.state);
    expect(again.game.phase()).toBe(game.phase());
    expect(again.game.state().units).toEqual(game.state().units);
  });

  it("does not believe written orders that do not lead to the saved position", () => {
    const { json } = play([{ FRANCE: { "A PAR": "A PAR - BUR" } }]);
    const wrong = [{ FRANCE: { "A PAR": "A PAR - PIC" } }];
    expect(given(loadSaved(json, wrong).history[0]!.orders)).toEqual(["A PAR - BUR"]);
    // Nor a record of the wrong length, nor one the engine cannot read.
    expect(given(loadSaved(json, []).history[0]!.orders)).toEqual(["A PAR - BUR"]);
    expect(given(loadSaved(json, [{ FRANCE: { "A PAR": "nonsense" } }]).history[0]!.orders)).toEqual(["A PAR - BUR"]);
  });

  it("loads a game with nothing resolved yet", () => {
    const { history, game } = loadSaved(new Game().toSaved("test"), []);
    expect(history).toEqual([]);
    expect(game.phase()).toBe("S1901M");
  });

  it("turns a file that is not a game into a sentence", () => {
    expect(() => loadSaved("{")).toThrow(ImportError);
    expect(() => loadSaved(JSON.stringify({ phases: [{ name: "S1901M", state: {} }] }))).toThrow(/not a Cabal game export/);
  });
});

describe("bookFromSaved", () => {
  let state: State;
  beforeAll(() => {
    state = new Game().state();
  });

  it("drops holds in a movement phase and keeps everything else", () => {
    const book = bookFromSaved({ FRANCE: ["A PAR - BUR", "F BRE H", "A MAR S A PAR - BUR"], ITALY: ["A VEN H"] }, "S1901M", state);
    expect(book).toEqual({ FRANCE: { "A PAR": "A PAR - BUR", "A MAR": "A MAR S A PAR - BUR" } });
  });

  it("names the dislodged unit in a retreat and drops the disbands nobody had to write", () => {
    // A fleet in Trieste dislodged by an army: the engine words its retreat as the army's.
    const retreat = { ...state, name: "F1901R", units: { ...state.units, AUSTRIA: ["*F TRI", "A VIE"], ITALY: ["A TRI"] } };
    expect(bookFromSaved({ AUSTRIA: ["A TRI R ALB"] }, "F1901R", retreat)).toEqual({ AUSTRIA: { "F TRI": "F TRI R ALB" } });
    expect(bookFromSaved({ AUSTRIA: ["F TRI D"] }, "F1901R", retreat)).toEqual({});
  });

  it("keeps builds, disbands and waives as they are", () => {
    expect(bookFromSaved({ FRANCE: ["A PAR B", "WAIVE"] }, "W1901A", state)).toEqual({
      FRANCE: { "B:PAR": "A PAR B", "WAIVE:0": "WAIVE" },
    });
  });
});
