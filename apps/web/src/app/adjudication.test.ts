import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ADJUDICATION_CASES, CABAL_CASES, DATC_CASES, ENGINE_CLAIM } from "./adjudication.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixture = (name: string) =>
  (JSON.parse(readFileSync(join(repo, "crates/cabal-engine/tests/data", name), "utf8")) as { cases: unknown[] }).cases.length;

/** Every file that may quote a case count in prose: the README, the docs, the site's pages and copy. */
function prose(): string[] {
  const walk = (dir: string, keep: (name: string) => boolean): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path, keep);
      return keep(entry.name) ? [path] : [];
    });
  return [
    join(repo, "README.md"),
    join(repo, "CONTRIBUTING.md"),
    ...walk(join(repo, "docs"), (name) => name.endsWith(".md")),
    ...walk(join(repo, "apps/web/site"), () => true),
    ...walk(join(repo, "apps/web/src"), (name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts")),
    ...walk(join(repo, "apps/web/scripts"), (name) => name.endsWith(".mjs")),
  ];
}

/**
 * A number stated as a count of test cases: "171 DATC", "178 of its adjudication test cases",
 * "171 of 171 DATC v3.0 cases", "DATC v3.0 corpus (171 cases", "(DATC v3.0, 171 cases)".
 */
const CLAIMS = [
  /\b(\d{3}) (?:of (?:its |the |\d{3} )?)?(?:DATC|Diplomacy Adjudicator Test Cases|(?:adjudication )?test cases|cases of the Diplomacy)/g,
  /DATC v3\.0(?: corpus)? ?[(,] ?(\d{3}) cases/g,
];

describe("the adjudication case counts", () => {
  it("match the fixtures the engine's tests run", () => {
    expect(DATC_CASES).toBe(fixture("datc_v3.json"));
    expect(CABAL_CASES).toBe(fixture("cabal_cases.json"));
    expect(ADJUDICATION_CASES).toBe(DATC_CASES + CABAL_CASES);
    expect(ENGINE_CLAIM).toContain(`all ${ADJUDICATION_CASES} `);
  });

  it("are the only counts quoted anywhere in the README, the docs or the site", () => {
    const wrong: string[] = [];
    let quoted = 0;
    for (const file of prose()) {
      const text = readFileSync(file, "utf8");
      for (const pattern of CLAIMS) {
        for (const match of text.matchAll(pattern)) {
          quoted++;
          const n = Number(match[1]);
          if (n !== DATC_CASES && n !== ADJUDICATION_CASES) wrong.push(`${relative(repo, file)}: "${match[0]}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // The patterns still find the README's own claims, so a rewording cannot silently skip them.
    expect(quoted).toBeGreaterThan(3);
  });

  it("are what the static pages' footer says", async () => {
    const script = pathToFileURL(join(repo, "apps/web/scripts/emit-agent-site.mjs")).href;
    const emit = (await import(/* @vite-ignore */ script)) as { ENGINE_CLAIM: string; renderTrustPage: (route: string, css: string) => string };
    expect(emit.ENGINE_CLAIM).toBe(ENGINE_CLAIM);
    expect(emit.renderTrustPage("/about", "/src/styles/app.css")).toContain(`<span>${ENGINE_CLAIM}</span>`);
  });
});
