import { describe, expect, it } from "vitest";
import { handleAgentRequest, type AssetEnv } from "./gateway.js";

function mockEnv(files: Record<string, { body: string; type: string }>): AssetEnv {
  return {
    ASSETS: {
      async fetch(input: RequestInfo | URL) {
        const url = typeof input === "string" || input instanceof URL ? new URL(String(input), "https://playcabal.pages.dev") : new URL(input.url);
        const path = url.pathname;
        const file = files[path];
        if (!file) return new Response("missing", { status: 404 });
        return new Response(file.body, {
          status: 200,
          headers: { "Content-Type": file.type },
        });
      },
    },
  };
}

const files = {
  "/index.html": { body: "<!doctype html><h1>Cabal Diplomacy</h1><p>home</p>", type: "text/html" },
  "/index.md": { body: "# Cabal\n\nDiplomacy with receipts.\n", type: "text/markdown" },
  "/about/index.html": { body: "<!doctype html><h1>About</h1>", type: "text/html" },
  "/about/index.md": { body: "# About Cabal\n\nWe build Diplomacy with receipts.\n", type: "text/markdown" },
  "/404.html": { body: "<!doctype html><h1>Not found</h1><p>See /llms.txt</p>", type: "text/html" },
  "/404.md": {
    body: "# Not found\n\nThat path does not exist on Cabal. See [llms.txt](/llms.txt) and the [sitemap](/sitemap.xml).\n",
    type: "text/markdown",
  },
  "/llms.txt": { body: "# Cabal\n\n> Diplomacy with receipts\n", type: "text/markdown" },
  "/assets/app.js": { body: "console.log(1)", type: "text/javascript" },
};

describe("handleAgentRequest", () => {
  const env = mockEnv(files);

  it("serves markdown for Accept: text/markdown on the homepage", async () => {
    const res = await handleAgentRequest(
      new Request("https://playcabal.pages.dev/", { headers: { Accept: "text/markdown" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Vary")).toMatch(/Accept/i);
    expect(await res.text()).toContain("Diplomacy with receipts");
  });

  it("serves HTML with Vary and Link for Accept: text/html", async () => {
    const res = await handleAgentRequest(
      new Request("https://playcabal.pages.dev/", { headers: { Accept: "text/html" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Vary")).toMatch(/Accept/i);
    expect(res.headers.get("Link")).toContain('rel="alternate"');
    expect(res.headers.get("Link")).toContain("llms.txt");
  });

  it("returns a real 404 with markdown body for unknown paths", async () => {
    const res = await handleAgentRequest(
      new Request("https://playcabal.pages.dev/some-path-that-does-not-exist", {
        headers: { Accept: "text/markdown" },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(20);
    expect(body.toLowerCase()).toContain("not found");
    expect(body).toContain("llms.txt");
  });

  it("returns a real HTML 404 for unknown browser paths", async () => {
    const res = await handleAgentRequest(
      new Request("https://playcabal.pages.dev/missing-page", { headers: { Accept: "text/html" } }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Not found");
  });

  it("passes through static assets unchanged", async () => {
    const res = await handleAgentRequest(new Request("https://playcabal.pages.dev/assets/app.js"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });
});
