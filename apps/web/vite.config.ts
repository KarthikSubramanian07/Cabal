import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { type HtmlTagDescriptor, type Plugin, defineConfig } from "vite";

/**
 * In production the Pages worker hands `/api` to the game server through a service binding
 * (src/agent/gateway.ts). Locally, run `pnpm --filter @cabal/server dev` and the same paths
 * are proxied to it, sockets included, so the client never needs a server address.
 */
const api = {
  "/api": { target: process.env.CABAL_SERVER ?? "http://localhost:8787", changeOrigin: true, ws: true },
};

/**
 * The board needs four things the entry script only asks for once it runs: the sandbox
 * page chunk, the map geometry, the WebAssembly engine and the display fonts. Left alone
 * they are found one after another. This writes hints into index.html so the browser
 * fetches them alongside the entry script, and inlines the small stylesheet so the first
 * paint does not wait on a second request. The stylesheet file is still emitted: the
 * static trust pages link to it.
 */
function firstLoad(): Plugin {
  return {
    name: "cabal:first-load",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle ?? {};
        const files = Object.keys(bundle);
        const find = (pattern: RegExp) => {
          const file = files.find((f) => pattern.test(f));
          if (!file) throw new Error(`cabal:first-load: nothing in the build matches ${pattern}`);
          return `/${file}`;
        };
        const tags: HtmlTagDescriptor[] = [
          ...[/SandboxPage-[\w-]+\.js$/, /board-[\w-]+\.js$/].map((pattern) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: find(pattern) },
            injectTo: "head" as const,
          })),
          {
            tag: "link",
            attrs: { rel: "preload", as: "fetch", type: "application/wasm", crossorigin: "anonymous", href: find(/cabal_engine_bg-[\w-]+\.wasm$/) },
            injectTo: "head",
          },
          ...[/archivo-black-latin-400-normal-[\w-]+\.woff2$/, /ibm-plex-mono-latin-400-normal-[\w-]+\.woff2$/].map((pattern) => ({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "anonymous", href: find(pattern) },
            injectTo: "head" as const,
          })),
        ];

        // Inline the stylesheet (about 6 KB compressed) in place of its <link>.
        const link = /<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/.exec(html);
        const css = link ? bundle[link[1]!] : undefined;
        if (!link || css?.type !== "asset") throw new Error("cabal:first-load: the stylesheet link is missing");
        const inlined = html.replace(link[0], () => `<style data-href="/${link[1]}">${String(css.source)}</style>`);
        return { html: inlined, tags };
      },
    },
  };
}

/** What the edge compresses on the way out. Fonts and images are already packed. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|wasm|xml|manifest\+json)|image\/svg\+xml)/;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
};

/**
 * `vite preview` on its own serves the app shell for every path and sends the engine
 * uncompressed, neither of which the real site does. This puts the Pages worker itself
 * (`dist/_worker.js`, built from src/agent/gateway.ts) in front of `dist`: the same routing,
 * the same 404s, the same security headers, and Brotli or gzip on everything Cloudflare
 * compresses. The end-to-end suite and Lighthouse then meet the site a visitor would.
 * `/api` is left to the proxy above.
 */
function edge(): Plugin {
  return {
    name: "cabal:edge",
    configurePreviewServer(server) {
      const dist = resolve(server.config.root, server.config.build.outDir);
      const packed = new Map<string, Buffer>();
      let worker: Promise<{ fetch: (request: Request, env: unknown) => Promise<Response> }> | undefined;

      /** The `ASSETS` binding: files from `dist` by their exact path, nothing clever. */
      const assets = {
        async fetch(input: RequestInfo | URL): Promise<Response> {
          const { pathname } = new URL(input instanceof Request ? input.url : String(input));
          const file = resolve(dist, `.${decodeURIComponent(pathname)}`);
          if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) return new Response("Not found", { status: 404 });
          const headers = new Headers({ "Content-Type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream" });
          // public/_headers, which Pages applies to assets.
          headers.set("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
          return new Response(new Uint8Array(await readFile(file)), { headers });
        },
      };

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if ((req.method !== "GET" && req.method !== "HEAD") || url.pathname === "/api" || url.pathname.startsWith("/api/")) return next();
        void (async () => {
          worker ??= import(/* @vite-ignore */ pathToFileURL(resolve(dist, "_worker.js")).href).then((m) => m.default);
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
          const response = await (await worker).fetch(new Request(url, { method: req.method ?? "GET", headers }), { ASSETS: assets });
          let body: Buffer = Buffer.from(await response.arrayBuffer());
          const out = new Headers(response.headers);
          // Plain http on localhost: do not ask the browser to upgrade the page's own requests.
          const csp = out.get("Content-Security-Policy");
          if (csp) out.set("Content-Security-Policy", csp.replace(/;\s*upgrade-insecure-requests/, ""));
          out.delete("Strict-Transport-Security");

          const accepts = String(req.headers["accept-encoding"] ?? "");
          const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
          if (encoding && body.length > 1024 && COMPRESSIBLE.test(out.get("Content-Type") ?? "")) {
            const key = `${encoding} ${response.status} ${url.pathname}`;
            let small = packed.get(key);
            if (!small) {
              small =
                encoding === "br"
                  ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
                  : gzipSync(body);
              packed.set(key, small);
            }
            body = small;
            out.set("Content-Encoding", encoding);
            out.append("Vary", "Accept-Encoding");
          }
          out.set("Content-Length", String(body.length));
          res.statusCode = response.status;
          out.forEach((value, name) => res.setHeader(name, value));
          res.end(req.method === "HEAD" ? undefined : body);
        })().catch(next);
      });
    },
  };
}

/**
 * `vite dev` has no `dist`, so `/about`, `/contact` and `/privacy` would fall through to the
 * app shell and its not-found page. Render them on request from the same Markdown and the
 * same template the build uses, styled by the stylesheet's source.
 */
function trustPagesInDev(): Plugin {
  return {
    name: "cabal:trust-pages-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/(.)\/$/, "$1");
        if (req.method !== "GET" || !/^\/(?:about|contact|privacy|404\.html)$/.test(path)) return next();
        void (async () => {
          const script = pathToFileURL(resolve(server.config.root, "scripts/emit-agent-site.mjs")).href;
          const site = (await import(/* @vite-ignore */ script)) as { renderTrustPage: (route: string, stylesheet: string) => string | null };
          const html = site.renderTrustPage(path, "/src/styles/index.css");
          if (html === null) return next();
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        })().catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), firstLoad(), edge(), trustPagesInDev()],
  build: { target: "esnext" },
  server: { port: 5173, strictPort: true, proxy: api },
  preview: { proxy: api },
});
