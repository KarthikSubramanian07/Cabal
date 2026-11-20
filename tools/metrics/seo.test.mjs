import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seoTable, summarise } from "./seo.mjs";

const audits = (scores) => ({
  categories: { seo: { score: scores.total, auditRefs: Object.keys(scores.audits).map((id) => ({ id })) } },
  audits: Object.fromEntries(Object.entries(scores.audits).map(([id, [score, mode]]) => [id, { id, score, scoreDisplayMode: mode ?? "binary" }])),
  finalDisplayedUrl: scores.url,
});

describe("the Lighthouse SEO verdict", () => {
  it("passes a page at or above the bar and names what failed", () => {
    const full = summarise(audits({ url: "http://localhost:8788/", total: 1, audits: { "meta-description": [1], "is-crawlable": [1], "structured-data": [null, "manual"] } }));
    assert.deepEqual(full, { url: "http://localhost:8788/", score: 100, failed: [], noindex: false, pass: true });
    const low = summarise(audits({ url: "http://localhost:8788/u/ada", total: 0.92, audits: { "meta-description": [0], "link-text": [1] } }));
    assert.deepEqual(low, { url: "http://localhost:8788/u/ada", score: 92, failed: ["meta-description"], noindex: false, pass: false });
  });

  it("reports a page kept out of indexes on purpose as such, not as a miss", () => {
    const table = summarise(audits({ url: "http://localhost:8788/g/K7Q2XZ", total: 0.66, audits: { "is-crawlable": [0], "meta-description": [1] } }));
    assert.equal(table.noindex, true);
    assert.equal(table.pass, true);
    // Anything else wrong with it still fails.
    assert.equal(summarise(audits({ url: "http://x/g/K7Q2XZ", total: 0.5, audits: { "is-crawlable": [0], "link-text": [0] } })).pass, false);
  });

  it("writes a table a reader can paste into the plan", () => {
    const rows = [
      { url: "http://localhost:8788/", score: 100, failed: [], noindex: false, pass: true },
      { url: "http://localhost:8788/g/K7Q2XZ", score: 66, failed: ["is-crawlable"], noindex: true, pass: true },
    ];
    assert.equal(seoTable(rows), "| Page | SEO | Failed audits | Result |\n|---|---|---|---|\n| `/` | 100 | none | pass |\n| `/g/K7Q2XZ` | 66 | is-crawlable | noindex by design |\n");
  });

  it("refuses a result with no SEO score", () => {
    assert.throws(() => summarise({ categories: {}, audits: {} }), /no SEO score/);
  });
});
