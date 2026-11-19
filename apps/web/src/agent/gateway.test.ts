import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, handleAgentRequest, type AssetEnv } from "./gateway.js";

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
  "/index.html": { body: "<!doctype html><html><head><title>Cabal</title></head><body><h1>Cabal Diplomacy</h1><p>home</p></body></html>", type: "text/html" },
  "/landing/index.html": { body: "<!doctype html><html><head><title>Cabal</title></head><body><h1>Shake hands. Seal it.</h1></body></html>", type: "text/html" },
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

  it("sets the security headers on pages, assets and 404s alike", async () => {
    for (const path of ["/", "/assets/app.js", "/missing-page"]) {
      const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, { headers: { Accept: "text/html" } }), env);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
    }
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("'wasm-unsafe-eval'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

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

  describe("app routes", () => {
    const html = { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } };

    it("serves the app shell for every client route", async () => {
      for (const path of ["/sandbox", "/games", "/ledger", "/g/K7Q2", "/u/ada", "/replay/K7Q2", "/g/K7Q2/"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toContain("<h1>Cabal Diplomacy</h1>");
        expect(res.headers.get("Content-Security-Policy"), path).toContain("connect-src 'self'");
      }
    });

    it("keeps tables and replays out of search indexes but not the public pages", async () => {
      for (const path of ["/g/K7Q2", "/replay/K7Q2"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
        expect(await res.text(), path).toContain('<meta name="robots" content="noindex, follow" />');
      }
      for (const path of ["/sandbox", "/games", "/ledger", "/u/ada"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.headers.get("X-Robots-Tag"), path).toBeNull();
      }
    });

    it("writes each address's own title and canonical link into the shell", async () => {
      const res = await handleAgentRequest(new Request("https://playcabal.pages.dev/u/ada", html), env);
      const text = await res.text();
      expect(text).toContain("<title>ada — Cabal</title>");
      expect(text).toContain('<link rel="canonical" href="https://playcabal.pages.dev/u/ada" />');
      expect(text).toContain('<meta property="og:url" content="https://playcabal.pages.dev/u/ada" />');
    });

    it("serves the front door from its prerendered shell, and the plain shell when there is none", async () => {
      const res = await handleAgentRequest(new Request("https://playcabal.pages.dev/", html), env);
      const text = await res.text();
      expect(text).toContain("Shake hands. Seal it.");
      expect(text).toContain('<link rel="canonical" href="https://playcabal.pages.dev/" />');
      const bare = mockEnv({ ...files, "/landing/index.html": undefined as never });
      const fallback = await handleAgentRequest(new Request("https://playcabal.pages.dev/", html), bare);
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toContain("Cabal Diplomacy");
    });

    it("still answers unknown paths with a real 404", async () => {
      for (const path of ["/g", "/g/a/b", "/games/extra", "/u/", "/replay", "/sandbox/extra", "/g/%3Cscript%3E"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.status, path).toBe(404);
      }
    });

    it("gives agents the home Markdown at /sandbox and a 404 for routes with no content", async () => {
      const md = { headers: { Accept: "text/markdown" } };
      const sandbox = await handleAgentRequest(new Request("https://playcabal.pages.dev/sandbox", md), env);
      expect(sandbox.status).toBe(200);
      expect(await sandbox.text()).toContain("Diplomacy with receipts");
      const game = await handleAgentRequest(new Request("https://playcabal.pages.dev/g/K7Q2", md), env);
      expect(game.status).toBe(404);
      expect(game.headers.get("Content-Type")).toContain("text/markdown");
    });
  });

  describe("/api proxy", () => {
    function withServer(handler: (request: Request) => Response | Promise<Response>) {
      const seen: Request[] = [];
      const server = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(String(input), init);
          seen.push(request);
          return handler(request);
        },
      };
      return { env: { ...env, SERVER: server } satisfies AssetEnv, seen };
    }

    it("hands /api requests to the SERVER binding with method, headers and body intact", async () => {
      const { env: bound, seen } = withServer(
        () =>
          new Response(JSON.stringify({ id: "K7Q2" }), {
            status: 201,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }),
      );
      const res = await handleAgentRequest(
        new Request("https://playcabal.pages.dev/api/games?x=1", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer seat" },
          body: JSON.stringify({ name: "table" }),
        }),
        bound,
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "K7Q2" });
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).pathname + new URL(seen[0]!.url).search).toBe("/api/games?x=1");
      expect(seen[0]!.method).toBe("POST");
      expect(seen[0]!.headers.get("Authorization")).toBe("Bearer seat");
      expect(await seen[0]!.json()).toEqual({ name: "table" });
      // Same origin: no CORS grant leaks out, and the transport headers are still set.
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Strict-Transport-Security")).toContain("max-age");
      // An API response is not a document: no HTML negotiation, no CSP rewrite.
      expect(res.headers.get("Vary")).toBeNull();
    });

    it("returns a WebSocket upgrade response untouched", async () => {
      // A 101 response cannot be built in Node, so stand in for the one workerd returns.
      const upgraded = { status: 101, webSocket: {} } as unknown as Response;
      const { env: bound, seen } = withServer(() => upgraded);
      const res = await handleAgentRequest(
        new Request("https://playcabal.pages.dev/api/games/K7Q2/ws", { headers: { Upgrade: "websocket" } }),
        bound,
      );
      expect(res).toBe(upgraded);
      expect(seen[0]!.headers.get("Upgrade")).toBe("websocket");
    });

    it("passes server errors through and never falls back to the app shell", async () => {
      const { env: bound } = withServer(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
      const res = await handleAgentRequest(
        new Request("https://playcabal.pages.dev/api/nope", { headers: { Accept: "text/html" } }),
        bound,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    it("answers 503 when the binding is missing instead of serving a page", async () => {
      const res = await handleAgentRequest(new Request("https://playcabal.pages.dev/api/games"), env);
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/json");
    });

    it("does not treat look-alike paths as the API", async () => {
      const { env: bound, seen } = withServer(() => new Response("server"));
      const res = await handleAgentRequest(
        new Request("https://playcabal.pages.dev/apiary", { headers: { Accept: "text/html" } }),
        bound,
      );
      expect(res.status).toBe(404);
      expect(seen).toHaveLength(0);
    });
  });
});
