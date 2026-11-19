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

/**
 * `vite preview` falls back to the app shell for any path without a file. In production the
 * Pages worker serves the static trust pages at their clean URLs, so do the same here: the
 * end-to-end suite then meets the pages a visitor would.
 */
function trustPages(): Plugin {
  return {
    name: "cabal:trust-pages",
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? "").split("?");
        if (/^\/(about|contact|privacy)\/?$/.test(path ?? "")) {
          req.url = `${path!.replace(/\/$/, "")}/index.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), firstLoad(), trustPages()],
  build: { target: "esnext" },
  server: { port: 5173, strictPort: true, proxy: api },
  preview: { proxy: api },
});
