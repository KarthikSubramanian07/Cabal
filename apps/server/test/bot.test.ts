/**
 * The real bot behind the AI seats: the Rust heuristic player from `@cabal/engine`, run inside the
 * room. Unlike the peaceful bot most suites use, it supports its attacks, so these games have
 * dislodgements, retreats and disbands, which is where an order validator earns its keep.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "@cabal/protocol";
import { botOrders } from "../src/bot.js";
import { botBrain } from "../src/brain.js";
import { Game, engineReady } from "../src/engine.js";
import { Client, create, realBots, sleep, sql, start, summary, until } from "./helpers.js";

realBots();
beforeAll(() => engineReady());

describe("the bot in the room", () => {
  it("is the engine's heuristic bot: deterministic, legal, and complete for every power", () => {
    const game = new Game();
    for (const power of ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]) {
      const orders = botBrain.orders(game, power, "seed");
      expect(orders).toEqual(botOrders(game, power, "seed"));
      const menu = game.legal(power).by_unit;
      expect(orders).toHaveLength(Object.keys(menu).length);
      for (const order of orders) expect(Object.values(menu).flat()).toContain(order);
    }
    // A seat the bot cannot play is left without orders; it never throws into a phase.
    expect(botOrders(game, "ATLANTIS", "seed")).toEqual([]);
    game.free();
  });

  it("plays six seats through years of real fighting: every phase resolves, retreats included", { timeout: 240_000 }, async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    let state = (await a.next("welcome")).p.state;
    let phase = "S1901M";
    const problems: string[] = [];
    const played: string[] = [];
    let dislodged = 0;
    let retreated = 0;
    for (let i = 0; i < 60; i++) {
      // Every AI seat that can act already has a complete set of orders on file, and is ready.
      const s = await summary(ann.gameId);
      if (s.status !== "active") break;
      // (A phase only the bots act in may already have resolved by itself: then there is nothing to check.)
      if (s.phase === phase) {
        for (const seat of s.seats.filter((x) => x.kind === "ai" && x.canAct)) {
          if (!seat.submitted || !seat.ready) problems.push(`${phase}: ${seat.power} is not ready with orders`);
        }
      }
      // Ann plays the same bot from the state she was sent, like any client could. A retreat she
      // reads straight off the state: the board lists where each dislodged unit may go, and a state
      // alone does not say where the attacker came from, which a retreat may not use.
      const game = Game.fromState(state);
      const mine = phase.endsWith("R")
        ? Object.entries(state.retreats[ann.power] ?? {}).map(([unit, options]) => (options.length > 0 ? `${unit} R ${options[i % options.length]}` : `${unit} D`))
        : botOrders(game, ann.power, "ann");
      game.free();
      if (phase.endsWith("R") && mine.length > 0) retreated++;
      if (mine.length > 0) {
        await sleep(220); // two frames a phase, inside the socket's ten a second
        a.send({ t: "orders.set", id: `o${i}`, p: { phase, orders: mine } });
        const ack = (await a.next("orders.ack", (m) => m.id === `o${i}`)).p;
        // The room's judge and the engine agree about every order the bot can write, retreats too.
        for (const v of ack.verdicts.filter((x) => !x.ok)) problems.push(`${phase}: ${v.text} refused: ${v.reason}`);
        a.send({ t: "ready", p: { phase, ready: true } });
      }
      const current = phase;
      // The next phase, or the end of the game (Ann may be eliminated, or somebody may win).
      const next = await until(async () => {
        const state = a.frames.find((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.p.phase !== current);
        return state ?? (a.frames.some((f) => f.t === "finished") ? "over" : null);
      }, `${current} to resolve`, 20_000);
      played.push(phase);
      // Take what arrived up to that frame and leave the rest: a phase only the bots act in resolves
      // at once, so the frames of the phase after it may already be here.
      const seen = next === "over" ? a.frames.splice(0) : a.frames.splice(0, a.frames.indexOf(next) + 1);
      for (const r of seen.filter((f): f is Extract<ServerMessage, { t: "results" }> => f.t === "results")) dislodged += r.p.dislodged.length;
      for (const e of seen.filter((f): f is Extract<ServerMessage, { t: "error" }> => f.t === "error")) problems.push(`${phase}: ${e.p.code} ${e.p.message}`);
      if (next === "over") break;
      phase = next.p.phase;
      state = next.p.state;
    }
    expect(problems.join(" // ")).toBe("");
    // No phase was resolved twice, and the game moved through real years.
    const names = (await sql<{ name: string }>(ann.gameId, "SELECT name FROM phases ORDER BY seq")).map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(played.length - 1);
    // The bot fights: units were dislodged and retreat phases were played, which the old random
    // walk never produced in 35 game years.
    expect(dislodged).toBeGreaterThan(0);
    expect(names.some((n) => n.endsWith("R"))).toBe(true);
    console.info(`bot soak: ${names.length} phases to ${names.at(-1)}, ${dislodged} units dislodged, ${retreated} retreat phases played by the human`);
    a.close();
  });
});
