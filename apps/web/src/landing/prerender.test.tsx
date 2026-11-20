import { describe, expect, it } from "vitest";
import { ADJUDICATION_CASES, CABAL_CASES, DATC_CASES } from "../app/adjudication.js";
import { renderLanding } from "./prerender.jsx";

/** The front door as a reader sees it: tags dropped, React's text separators gone, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the prerendered front door", () => {
  it("quotes the case counts as a sentence, with a space between every word and number", () => {
    expect(text(renderLanding())).toContain(
      `passes all ${ADJUDICATION_CASES} of its test cases: every one of the ${DATC_CASES} Diplomacy Adjudicator Test Cases, and ${CABAL_CASES} rulings of its own`,
    );
  });
});
