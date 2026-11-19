import { metaFor, writeHead } from "../app/meta.js";
import { matchRoute } from "../app/routes.js";
import {
  appendVaryAccept,
  markdownPath,
  normalizePath,
  preferredType,
} from "./negotiate.js";

interface Fetcher {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface AssetEnv {
  ASSETS: Fetcher;
  /**
   * Service binding to the `cabal-server` Worker (see wrangler.jsonc). `/api/*` is handed to
   * it so the browser only ever talks to this origin and the CSP can stay `connect-src 'self'`.
   */
  SERVER?: Fetcher;
}

/** Paths that have authored HTML + Markdown content (not the SPA shell alone). */
export const CONTENT_ROUTES = new Set(["/", "/about", "/contact", "/privacy"]);

const STATIC_EXT =
  /\.(?:html?|css|js|mjs|map|png|jpe?g|webp|gif|svg|avif|ico|woff2?|ttf|otf|eot|xml|txt|json|webmanifest|wasm|md|pdf)$/i;

export function isStaticAsset(pathname: string): boolean {
  return STATIC_EXT.test(pathname);
}

/** `/api` and everything under it belongs to the game server. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Client routes that are not authored content: the edge answers them with the app shell and
 * the browser router draws the page.
 */
export function isAppRoute(pathname: string): boolean {
  return !CONTENT_ROUTES.has(pathname) && matchRoute(pathname) !== null;
}

/**
 * The front door has its own copy of the shell, with the landing page already drawn in it
 * (scripts/emit-agent-site.mjs), so its headline paints before any script has run.
 */
export const LANDING_SHELL = "/landing/index.html";

function htmlAssetPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === "/") return LANDING_SHELL;
  if (isAppRoute(path)) return "/index.html";
  return `${path}/index.html`;
}

/** The shell with this address's own title, description, canonical link and share card. */
async function withPageHead(res: Response, path: string): Promise<Response> {
  const html = writeHead(await res.text(), metaFor(path));
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status: res.status, headers });
}

async function fetchAsset(env: AssetEnv, url: URL, pathname: string, request: Request): Promise<Response> {
  const assetUrl = new URL(url.toString());
  assetUrl.pathname = pathname;
  // Use a clean GET so asset subrequests are not negotiated again if they re-enter the worker.
  return env.ASSETS.fetch(
    new Request(assetUrl.toString(), {
      method: "GET",
      headers: { Accept: "*/*", "User-Agent": request.headers.get("User-Agent") ?? "cabal-agent-gateway" },
    }),
  );
}

function withNegotiationHeaders(res: Response, contentType?: string): Response {
  const out = new Response(res.body, res);
  if (contentType) out.headers.set("Content-Type", contentType);
  appendVaryAccept(out.headers);
  return out;
}

async function notFound(env: AssetEnv, url: URL, request: Request, asMarkdown: boolean): Promise<Response> {
  if (asMarkdown) {
    const md = await fetchAsset(env, url, "/404.md", request);
    if (md.status === 200) {
      return withNegotiationHeaders(
        new Response(md.body, { status: 404, headers: md.headers }),
        "text/markdown; charset=utf-8",
      );
    }
    const fallback = `# Not found\n\nThat path does not exist on Cabal. See [llms.txt](https://playcabal.pages.dev/llms.txt), the [sitemap](https://playcabal.pages.dev/sitemap.xml), or [about](https://playcabal.pages.dev/about).\n`;
    const res = new Response(fallback, {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
    appendVaryAccept(res.headers);
    return res;
  }

  const html = await fetchAsset(env, url, "/404.html", request);
  if (html.status === 200) {
    return withNegotiationHeaders(new Response(html.body, { status: 404, headers: html.headers }));
  }
  const res = new Response("<!doctype html><title>Not found</title><h1>Not found</h1><p>See /llms.txt</p>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  appendVaryAccept(res.headers);
  return res;
}

/**
 * Security headers for every response. Pages does not apply `_headers` to responses returned by a
 * `_worker.js`, so the gateway sets them itself. The game is fully client side: scripts, styles,
 * fonts and the WebAssembly engine are all same-origin.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Headers that still make sense on a JSON API response. */
const API_HEADERS = ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy"] as const;

/**
 * Hand an `/api` request to the game server untouched: method, headers, body and, for the
 * game socket, the WebSocket upgrade. A `101 Switching Protocols` response carries the
 * socket and must be returned as it is, so only ordinary responses get headers added.
 */
async function proxyApi(request: Request, env: AssetEnv): Promise<Response> {
  if (!env.SERVER) {
    return new Response(JSON.stringify({ error: "game server unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const res = await env.SERVER.fetch(request);
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const name of API_HEADERS) out.headers.set(name, SECURITY_HEADERS[name]!);
  // Same origin now: the server's permissive CORS grant is not needed and should not leak out.
  out.headers.delete("Access-Control-Allow-Origin");
  return out;
}

export async function handleAgentRequest(request: Request, env: AssetEnv): Promise<Response> {
  if (isApiPath(new URL(request.url).pathname)) return proxyApi(request, env);
  const res = await route(request, env);
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

async function route(request: Request, env: AssetEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (isStaticAsset(path)) {
    const asset = await fetchAsset(env, url, path === "/llms.txt" ? "/llms.txt" : path, request);
    if (asset.status === 404 && !STATIC_EXT.test(path)) {
      return notFound(env, url, request, false);
    }
    // llms.txt and *.md should advertise correct types when served as files
    if (path.endsWith(".md") || path === "/llms.txt") {
      const res = new Response(asset.body, asset);
      if (asset.status === 200) {
        res.headers.set("Content-Type", "text/markdown; charset=utf-8");
      }
      return res;
    }
    return asset;
  }

  const accept = request.headers.get("accept");
  const chosen = preferredType(accept, ["text/html", "text/markdown"]);

  if (chosen === null && accept) {
    const res = new Response("Not Acceptable\n\nAvailable: text/html, text/markdown\n", {
      status: 406,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    appendVaryAccept(res.headers);
    return res;
  }

  const isContent = CONTENT_ROUTES.has(path);
  const isApp = isAppRoute(path);

  if (isApp) {
    // The shell is HTML only. `/sandbox` shares the home page's Markdown; the reserved
    // routes have no content to describe yet, so an agent asking for Markdown gets a 404.
    if (chosen === "text/markdown" && path !== "/sandbox") return notFound(env, url, request, true);
    if (chosen !== "text/markdown") {
      const shell = await fetchAsset(env, url, "/index.html", request);
      if (shell.status !== 200) return notFound(env, url, request, false);
      const res = withNegotiationHeaders(await withPageHead(shell, path));
      // Tables and replays are for the people sent the code: keep them out of search indexes.
      if (!metaFor(path).index) res.headers.set("X-Robots-Tag", "noindex");
      return res;
    }
  }

  const wantsMarkdown = chosen === "text/markdown";
  const contentPath = path === "/sandbox" ? "/" : path;

  if (wantsMarkdown) {
    if (!isContent && !isApp) {
      return notFound(env, url, request, true);
    }
    const mdRes = await fetchAsset(env, url, markdownPath(contentPath), request);
    if (mdRes.status === 200) {
      return withNegotiationHeaders(mdRes, "text/markdown; charset=utf-8");
    }
    if (!preferredType(accept, ["text/html"])) {
      const res = new Response("Not Acceptable\n\nMarkdown sibling missing and HTML is not acceptable.\n", {
        status: 406,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
      appendVaryAccept(res.headers);
      return res;
    }
  }

  if (!isContent && !isApp) {
    return notFound(env, url, request, false);
  }

  let htmlRes = await fetchAsset(env, url, htmlAssetPath(path), request);
  // A build without the prerendered front door still has the plain shell, which draws it too.
  if (path === "/" && htmlRes.status !== 200) htmlRes = await fetchAsset(env, url, "/index.html", request);
  if (htmlRes.status !== 200) {
    return notFound(env, url, request, false);
  }

  const res = withNegotiationHeaders(path === "/" ? await withPageHead(htmlRes, path) : htmlRes);
  const linkMd = `<${markdownPath(contentPath)}>; rel="alternate"; type="text/markdown"`;
  const linkLlms = `</llms.txt>; rel="describedby"`;
  const existing = res.headers.get("link");
  res.headers.set("Link", existing ? `${existing}, ${linkMd}, ${linkLlms}` : `${linkMd}, ${linkLlms}`);
  return res;
}
