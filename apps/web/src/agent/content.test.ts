import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const siteDir = join(import.meta.dirname, "../../site");

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/[#>*_`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("agent site content", () => {
  it("keeps trust and homepage markdown above the 500 character floor", () => {
    for (const name of ["home.md", "about.md", "contact.md", "privacy.md"]) {
      const text = plainText(readFileSync(join(siteDir, name), "utf8"));
      expect(text.length, name).toBeGreaterThanOrEqual(500);
    }
  });

  it("ships llms.txt with a when-to-use section", () => {
    const llms = readFileSync(join(siteDir, "llms.txt"), "utf8");
    expect(llms.startsWith("# Cabal")).toBe(true);
    expect(llms.toLowerCase()).toContain("when to use");
    expect(llms).toContain("https://playcabal.pages.dev");
  });

  it("keeps 404 markdown long enough for agents", () => {
    const body = readFileSync(join(siteDir, "404.md"), "utf8");
    expect(body.length).toBeGreaterThan(20);
    expect(body.toLowerCase()).toContain("not found");
    expect(body).toContain("llms.txt");
  });

  it("only authors expected markdown siblings", () => {
    const names = readdirSync(siteDir).sort();
    expect(names).toEqual([
      "404.md",
      "about.md",
      "contact.md",
      "home.md",
      "llms.txt",
      "privacy.md",
    ]);
  });
});
