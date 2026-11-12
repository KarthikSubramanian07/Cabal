import { describe, expect, it } from "vitest";
import { adjudicateStrict } from "../src/adjudicate-guard.js";

describe("adjudicateStrict", () => {
  it("rethrows and never calls process when normalisation fails", () => {
    const reported: unknown[] = [];
    let processed = false;
    const game = {
      normaliseOrders: (_input: { orders: string[] }): { orders: string[] } => {
        throw new Error("engine broke");
      },
      process: (_input: { orders: string[] }): string => {
        processed = true;
        return "ok";
      },
    };
    expect(() => adjudicateStrict(game, { orders: [] }, (e) => reported.push(e))).toThrow("engine broke");
    expect(processed).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it("returns the outcome when the engine succeeds", () => {
    const game = {
      normaliseOrders: (input: { orders: string[] }) => input,
      process: (input: { orders: string[] }) => `processed ${input.orders.length}`,
    };
    expect(adjudicateStrict(game, { orders: ["a", "b"] }, () => {})).toBe("processed 2");
  });

  it("reports and rethrows a process failure instead of returning a fallback outcome", () => {
    const failure = new Error("adjudication failed");
    const reported: unknown[] = [];
    const game = {
      normaliseOrders: (input: { orders: string[] }) => input,
      process: (_input: { orders: string[] }): string => {
        throw failure;
      },
    };

    expect(() => adjudicateStrict(game, { orders: [] }, (error) => reported.push(error))).toThrow(failure);
    expect(reported).toEqual([failure]);
  });
});
