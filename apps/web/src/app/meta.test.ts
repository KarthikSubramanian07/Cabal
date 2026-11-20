import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHARE_IMAGE, SHARE_IMAGE_ALT, metaFor, writeHead } from "./meta.js";

describe("metaFor", () => {
  it("gives every page its own title, description and canonical address", () => {
    const paths = ["/", "/sandbox", "/games", "/ledger", "/u/ada", "/g/K7Q2XZ", "/replay/K7Q2XZ"];
    const metas = paths.map(metaFor);
    expect(new Set(metas.map((m) => m.title)).size).toBe(paths.length);
    expect(new Set(metas.map((m) => m.description)).size).toBe(paths.length);
    expect(metas.map((m) => m.canonical)).toEqual(paths.map((p) => `https://playcabal.pages.dev${p}`));
    for (const m of metas) {
      expect(m.title).toMatch(/Cabal/);
      expect(m.description.length).toBeGreaterThan(50);
      expect(m.description.length).toBeLessThanOrEqual(170);
    }
  });

  it("indexes the public pages and keeps tables and replays out", () => {
    expect(metaFor("/").index).toBe(true);
    expect(metaFor("/ledger").index).toBe(true);
    expect(metaFor("/u/ada").index).toBe(true);
    expect(metaFor("/g/K7Q2XZ").index).toBe(false);
    expect(metaFor("/replay/K7Q2XZ").index).toBe(false);
    expect(metaFor("/nope").index).toBe(false);
  });

  it("drops a trailing slash from the canonical address and splits a table code", () => {
    expect(metaFor("/ledger/").canonical).toBe("https://playcabal.pages.dev/ledger");
    expect(metaFor("/g/k7q2xz").title).toBe("Table K7Q 2XZ — Cabal");
  });
});

describe("writeHead", () => {
  const shell = `<html><head><title>Old</title><meta name="description" content="old" /><link rel="canonical" href="https://playcabal.pages.dev/" /><meta property="og:url" content="https://playcabal.pages.dev/" /><meta property="og:title" content="Old" /></head><body></body></html>`;

  it("replaces the tags that are there and adds the ones that are not", () => {
    const out = writeHead(shell, metaFor("/u/ada"));
    expect(out).toContain("<title>ada — Cabal</title>");
    expect(out).toContain('<link rel="canonical" href="https://playcabal.pages.dev/u/ada" />');
    expect(out).toContain('<meta property="og:url" content="https://playcabal.pages.dev/u/ada" />');
    expect(out).toContain('<meta name="robots" content="index, follow" />');
    expect(out).toContain('<meta name="twitter:title" content="ada — Cabal" />');
    expect(out.match(/<title>/g)).toHaveLength(1);
  });

  it("escapes what goes into an attribute", () => {
    const out = writeHead(shell, { ...metaFor("/"), title: 'A "quoted" <title> & more' });
    expect(out).toContain("<title>A &quot;quoted&quot; &lt;title&gt; &amp; more</title>");
  });

  it("gives a table and its replay their own card, and every other page the site's", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const table = writeHead(html, metaFor("/g/k7q2xz"));
    expect(table).toContain('<meta property="og:image" content="https://playcabal.pages.dev/share/g/K7Q2XZ.png" />');
    expect(table).toContain('<meta name="twitter:image" content="https://playcabal.pages.dev/share/g/K7Q2XZ.png" />');
    expect(table).toMatch(/<meta property="og:image:alt" content="The board of Diplomacy table K7Q 2XZ as it stands/);
    // The card's size tags are untouched: the table's card is drawn at the same 1200 by 630.
    expect(table).toContain('<meta property="og:image:width" content="1200" />');
    expect(table.match(/property="og:image"/g)).toHaveLength(1);
    expect(writeHead(html, metaFor("/replay/K7Q2XZ"))).toContain("/share/g/K7Q2XZ.png");
    const ledger = writeHead(html, metaFor("/ledger"));
    expect(ledger).toContain(`<meta property="og:image" content="${SHARE_IMAGE}" />`);
  });

  it("describes the site's card in the same words as the shell does", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html).toContain(`<meta property="og:image:alt" content="${SHARE_IMAGE_ALT}" />`);
    expect(html).toContain(`<meta name="twitter:image:alt" content="${SHARE_IMAGE_ALT}" />`);
  });
});

