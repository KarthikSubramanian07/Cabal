import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game, ready } from "@cabal/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_RECEIPTS } from "./receipts.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

describe("the front door's example receipts", () => {
  it("print only orders the rules allow, for units each power starts with", () => {
    const game = new Game();
    for (const r of EXAMPLE_RECEIPTS) {
      const [verdict] = game.validateOrders(r.power, [r.order]);
      expect(verdict, `${r.who}: ${r.order}`).toMatchObject({ legal: true });
    }
  });
});
