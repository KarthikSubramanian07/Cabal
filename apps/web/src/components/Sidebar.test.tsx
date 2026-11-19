import type { OrderResult, PhaseOutcome, State } from "@cabal/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { whyOfResult } from "../game/explain/explain.js";
import { Results, whyKey } from "./Sidebar.jsx";

const result = (r: Partial<OrderResult> & Pick<OrderResult, "power" | "unit" | "order" | "ok" | "code">): OrderResult =>
  ({ reason: r.code, summary: r.code, by: [], ...r }) as OrderResult;
const outcome = (results: OrderResult[]): PhaseOutcome =>
  ({ phase: "", results, next: {} as State, standoffs: [], dislodged: [], civil_disorder: [], status: "active" }) as unknown as PhaseOutcome;

describe("the receipts' Why?", () => {
  it("is not offered for a disband, which the receipt itself calls neutral", () => {
    const disband = result({ power: "GERMANY", unit: "A BUR", order: "A BUR D", ok: false, code: "disband", reason: "disbanded" });
    const html = renderToStaticMarkup(
      <Results
        record={{ phase: "F1901R", orders: { GERMANY: { "A BUR": "A BUR D" } }, outcome: outcome([disband]) }}
        explain={(r) => whyOfResult(r, "F1901R")}
      />,
    );
    expect(html).toContain("receipt neutral");
    expect(html).not.toContain("why-toggle");
  });

  it("opens one panel, with an id of its own, when one power has two failed builds", () => {
    // Builds have no unit yet, so the unit alone cannot tell them apart.
    const a = result({ power: "GERMANY", unit: "", order: "A BER B", ok: false, code: "illegal", reason: "illegal (Occupied)" });
    const b = result({ power: "GERMANY", unit: "", order: "A MUN B", ok: false, code: "illegal", reason: "illegal (Occupied)" });
    const html = renderToStaticMarkup(
      <Results
        record={{ phase: "W1901A", orders: { GERMANY: { x: "A BER B", y: "A MUN B" } }, outcome: outcome([a, b]) }}
        explain={(r) => whyOfResult(r, "W1901A")}
        open={whyKey(a, 0)}
      />,
    );
    expect(html.match(/class="why-panel"/g)?.length ?? 0).toBe(1);
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
