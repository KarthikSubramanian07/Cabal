import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, handleAgentRequest, type AssetEnv } from "./gateway.js";
import { readChunks, readPalette } from "./png.js";
import layout from "./share-card.json";

function mockEnv(files: Record<string, { body: string | Uint8Array; type: string }>): AssetEnv {
  return {
    ASSETS: {
      async fetch(input: RequestInfo | URL) {
        const url = typeof input === "string" || input instanceof URL ? new URL(String(input), "https://playcabal.pages.dev") : new URL(input.url);
        const path = url.pathname;
        const file = files[path];
        if (!file) return new Response("missing", { status: 404 });
        return new Response(file.body as BodyInit, {
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
      for (const path of ["/sandbox", "/games", "/ledger", "/g/K7Q2XZ", "/u/ada", "/replay/K7Q2XZ", "/g/k7q2xz/"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toContain("<h1>Cabal Diplomacy</h1>");
        expect(res.headers.get("Content-Security-Policy"), path).toContain("connect-src 'self'");
      }
    });

    it("keeps tables and replays out of search indexes but not the public pages", async () => {
      for (const path of ["/g/K7Q2XZ", "/replay/K7Q2XZ"]) {
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

    it("answers a table or replay code that cannot exist with a 404 no index keeps", async () => {
      for (const path of ["/g/K7Q2", "/replay/zzzz", "/g/K7Q2X0"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), env);
        expect(res.status, path).toBe(404);
        expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
        // Still the app, which draws its own "no table goes by that code".
        expect(await res.text(), path).toContain("<h1>Cabal Diplomacy</h1>");
      }
    });

    it("keeps the board's preloads for pages that draw it, and drops them for the rest", async () => {
      const preloads =
        '<link rel="modulepreload" crossorigin href="/assets/SandboxPage-abc.js"><link rel="modulepreload" crossorigin href="/assets/board-def.js">' +
        '<link rel="preload" as="fetch" type="application/wasm" crossorigin="anonymous" href="/assets/cabal_engine_bg-123.wasm">';
      const shell = mockEnv({ ...files, "/index.html": { body: `<!doctype html><html><head><title>Cabal</title>${preloads}</head><body><h1>Cabal Diplomacy</h1></body></html>`, type: "text/html" } });
      for (const path of ["/sandbox", "/g/K7Q2XZ", "/replay/K7Q2XZ"]) {
        const text = await (await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), shell)).text();
        expect(text, path).toContain("cabal_engine_bg-123.wasm");
        expect(text, path).toContain("board-def.js");
      }
      for (const path of ["/ledger", "/u/ada", "/games"]) {
        const text = await (await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), shell)).text();
        expect(text, path).not.toContain("cabal_engine_bg");
        expect(text, path).not.toContain("board-def.js");
        expect(text, path).not.toContain("SandboxPage");
      }
    });

    it("asks the game server about a handle: nobody's is a 404, anyone's is named as they write it", async () => {
      const asked: string[] = [];
      const server = {
        async fetch(input: RequestInfo | URL) {
          const url = new URL(input instanceof Request ? input.url : String(input));
          asked.push(url.pathname);
          // Handles are found whatever their case, as the server finds them.
          if (url.pathname.toLowerCase() === "/api/players/kestrel") return Response.json({ player: { id: "p1", handle: "Kestrel", createdAt: 1 } });
          if (url.pathname === "/api/players/broken") return new Response("down", { status: 503 });
          return Response.json({ error: "no such player" }, { status: 404 });
        },
      };
      const live = { ...env, SERVER: server } satisfies AssetEnv;
      const nobody = await handleAgentRequest(new Request("https://playcabal.pages.dev/u/Nobody_ever_here", html), live);
      expect(nobody.status).toBe(404);
      expect(nobody.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(await nobody.text()).toContain('<meta name="robots" content="noindex, follow" />');
      // Every spelling of a handle shares the one its owner writes.
      for (const path of ["/u/kestrel", "/u/KESTREL"]) {
        const res = await handleAgentRequest(new Request(`https://playcabal.pages.dev${path}`, html), live);
        expect(res.status, path).toBe(200);
        const text = await res.text();
        expect(text, path).toContain('<link rel="canonical" href="https://playcabal.pages.dev/u/Kestrel" />');
        expect(text, path).toContain("<title>Kestrel — Cabal</title>");
      }
      // A server that cannot say does not turn a record away.
      expect((await handleAgentRequest(new Request("https://playcabal.pages.dev/u/broken", html), live)).status).toBe(200);
      expect(asked).toContain("/api/players/Nobody_ever_here");
    });

    it("gives agents the home Markdown at /sandbox and a 404 for routes with no content", async () => {
      const md = { headers: { Accept: "text/markdown" } };
      const sandbox = await handleAgentRequest(new Request("https://playcabal.pages.dev/sandbox", md), env);
      expect(sandbox.status).toBe(200);
      expect(await sandbox.text()).toContain("Diplomacy with receipts");
      const game = await handleAgentRequest(new Request("https://playcabal.pages.dev/g/K7Q2XZ", md), env);
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

  describe("a table's share card", () => {
    const board = new Uint8Array(readFileSync(new URL("../../public/share/board.png", import.meta.url)));
    const withBoard = mockEnv({ ...files, "/share/board.png": { body: board, type: "image/png" } });
    const saved = { gameId: "K7Q2XZ", phase: "F1902M", centers: { FRANCE: ["PAR", "MAR", "BRE", "SPA"], ENGLAND: ["LON"] } };
    function live(answer: (path: string) => Response) {
      const asked: string[] = [];
      const from: (string | null)[] = [];
      const server = {
        async fetch(input: RequestInfo | URL) {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          asked.push(path);
          from.push(input instanceof Request ? input.headers.get("cf-connecting-ip") : null);
          return answer(path);
        },
      };
      return { env: { ...withBoard, SERVER: server } satisfies AssetEnv, asked, from };
    }

    it("draws the table's centres from the server's light answer, in any case of the code", async () => {
      const { env: bound, asked, from } = live(() => Response.json(saved));
      const res = await handleAgentRequest(new Request("https://playcabal.pages.dev/share/g/k7q2xz.png", { headers: { "cf-connecting-ip": "203.0.113.9" } }), bound);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      // Only the centres, not the whole saved game, and read as the visitor who asked, so one
      // scraper cannot spend every other card's read budget.
      expect(asked).toEqual(["/api/games/K7Q2XZ/centres"]);
      expect(from).toEqual(["203.0.113.9"]);
      const card = new Uint8Array(await res.arrayBuffer());
      const palette = readPalette(card);
      expect(layout.notches.FRANCE.slice(0, 5).map((i) => palette[i]!.join())).toEqual([...Array(4).fill("78,163,208"), layout.notch.join()]);
      expect(palette[layout.centres.LON]).not.toEqual(layout.land);
      expect(palette[layout.centres.BER]).toEqual(layout.land);
      // The pixels are the shipped board's.
      expect(readChunks(card).find((c) => c.type === "IDAT")!.data).toEqual(readChunks(board).find((c) => c.type === "IDAT")!.data);
    });

    it("answers 404 for a code that cannot exist or names no game, and the neutral board when the server cannot say", async () => {
      const { env: bound, asked } = live((path) => (path.includes("ZZZZZZ") ? Response.json({ error: "no such game" }, { status: 404 }) : new Response("down", { status: 503 })));
      expect((await handleAgentRequest(new Request("https://playcabal.pages.dev/share/g/K7Q2X0.png"), bound)).status).toBe(404);
      expect(asked).toEqual([]);
      const missing = await handleAgentRequest(new Request("https://playcabal.pages.dev/share/g/ZZZZZZ.png"), bound);
      expect(missing.status).toBe(404);
      const down = await handleAgentRequest(new Request("https://playcabal.pages.dev/share/g/K7Q2XZ.png"), bound);
      expect(down.status).toBe(200);
      expect(down.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(new Uint8Array(await down.arrayBuffer())).toEqual(board);
    });

    it("points a table's page and its replay at the card", async () => {
      const { env: bound } = live(() => Response.json(saved));
      const shell = { ...files, "/index.html": { body: readFileSync(new URL("../../index.html", import.meta.url), "utf8"), type: "text/html" } };
      const page = await handleAgentRequest(new Request("https://playcabal.pages.dev/g/K7Q2XZ", { headers: { Accept: "text/html" } }), { ...mockEnv(shell), SERVER: bound.SERVER });
      expect(await page.text()).toContain('<meta property="og:image" content="https://playcabal.pages.dev/share/g/K7Q2XZ.png" />');
    });
  });
});
