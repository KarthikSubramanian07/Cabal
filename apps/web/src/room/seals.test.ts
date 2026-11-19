import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ready } from "@cabal/engine";
import type { OrderResultView } from "@cabal/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { checkReceipt, checkSeal, makeSeal, shortCommitment } from "./seals.js";

beforeAll(async () => {
  await ready(readFileSync(fileURLToPath(new URL("../../../../packages/engine/pkg/cabal_engine_bg.wasm", import.meta.url))));
});

const result = (order: string, ok = true): OrderResultView => ({ power: "FRANCE", unit: order.slice(0, 5), order, ok, code: ok ? "ok" : "bounce", reason: "" });

describe("seals", () => {
  it("seals on this device and opens again with the same orders and nonce", () => {
    const seal = makeSeal(["A PAR - BUR", "F BRE - MAO"], true);
    expect(seal.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(seal.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(checkSeal({ commitment: seal.commitment, orders: seal.orders, nonce: seal.nonce })).toBe("opens");
  });

  it("refuses a tampered order, a tampered nonce, and stays closed while either is secret", () => {
    const seal = makeSeal(["A PAR - BUR"], true);
    expect(checkSeal({ commitment: seal.commitment, orders: ["A PAR - PIC"], nonce: seal.nonce })).toBe("fails");
    expect(checkSeal({ commitment: seal.commitment, orders: seal.orders, nonce: "0".repeat(32) })).toBe("fails");
    expect(checkSeal({ commitment: seal.commitment, orders: null, nonce: null })).toBe("closed");
    expect(checkSeal({ commitment: seal.commitment, orders: seal.orders, nonce: null })).toBe("closed");
  });

  it("checks a receipt against the adjudication this device saw", () => {
    const pledge = { pledger: "FRANCE" as const, orders: ["A PAR - BUR"] };
    const done = [result("A PAR - BUR", false), result("F BRE H")];
    expect(checkReceipt({ ...pledge, receipt: "kept" }, done)).toBe("agrees");
    // Kept, though the pledged order was never given: wrong.
    expect(checkReceipt({ ...pledge, receipt: "kept" }, [result("A PAR - PIC")])).toBe("disagrees");
    // Broken, though the order was given exactly: wrong.
    expect(checkReceipt({ ...pledge, receipt: "broken" }, done)).toBe("disagrees");
    expect(checkReceipt({ ...pledge, receipt: "broken" }, [result("A PAR - PIC")])).toBe("agrees");
    // A pledged hold looks the same as a silent unit, so a broken hold cannot be called wrong.
    expect(checkReceipt({ pledger: "FRANCE", orders: ["A PAR H"], receipt: "broken" }, [result("A PAR H")])).toBe("agrees");
    expect(checkReceipt({ ...pledge, receipt: "void" }, done)).toBe("unknown");
    expect(checkReceipt({ ...pledge, receipt: "kept" }, null)).toBe("unknown");
  });

  it("shortens a commitment for reading aloud", () => {
    expect(shortCommitment("abcdef0123456789".repeat(4))).toBe("abcdef…6789");
  });
});
