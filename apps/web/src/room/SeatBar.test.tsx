import type { SeatView } from "@cabal/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeatBar } from "./SeatBar.jsx";

const seat = (s: Partial<SeatView> & Pick<SeatView, "power" | "kind">): SeatView => ({
  name: null,
  handle: null,
  ready: false,
  eliminated: false,
  missed: 0,
  brain: null,
  present: true,
  submitted: false,
  canAct: true,
  host: false,
  ...s,
});

const SEATS: SeatView[] = [
  seat({ power: "AUSTRIA", kind: "human", name: "Envoy_4821", handle: "Envoy_4821" }),
  seat({ power: "ENGLAND", kind: "human", name: "Bea" }),
  seat({ power: "FRANCE", kind: "ai", name: "Automaton", brain: "bot" }),
];

const cells = (place: "side" | "stage") =>
  renderToStaticMarkup(<SeatBar seats={SEATS} me="ENGLAND" running centres={{ AUSTRIA: 3 }} place={place} />)
    .split("<li")
    .slice(1);

describe("the seat strip's names", () => {
  it("leads from a signed-in player's cell to their record, the whole cell the target", () => {
    const [austria] = cells("side");
    expect(austria).toContain('class="chair-link" href="/u/Envoy_4821"');
    expect(austria).toContain("Envoy_4821&#x27;s record.");
    // The name is printed (on a wide screen) and marked as a way somewhere.
    expect(austria).toMatch(/^ class="chair [^"]*has-record/);
    expect(austria).toContain('<span class="chair-name" aria-hidden="true">Envoy_4821</span>');
  });

  it("gives a guest and the bot a name but no link, having no record", () => {
    const [, england, france] = cells("side");
    for (const cell of [england, france]) {
      expect(cell).not.toContain("<a ");
      expect(cell).not.toContain("has-record");
    }
    expect(england).toContain(">Bea</span>");
    expect(france).toContain(">Bot</span>");
  });

  it("keeps the link over the map on a phone, where the name itself is left to the cell's label", () => {
    const [austria] = cells("stage");
    expect(austria).toContain('href="/u/Envoy_4821"');
  });
});
