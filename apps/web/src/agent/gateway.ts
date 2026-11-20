import { type PageMeta, metaFor, replayIndexable, writeHead } from "../app/meta.js";
import { type RouteMatch, matchRoute } from "../app/routes.js";
import { isGameCode } from "../net/code.js";
import { hintsFor } from "./hints.js";
import { centresOf, shareCard } from "./share-card.js";
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

/** The shell with this address's own title, description, canonical link and share card, and its own hints. */
async function withPageHead(res: Response, path: string, meta: PageMeta = metaFor(path), status = res.status, route: string | null = null): Promise<Response> {
  const html = hintsFor(writeHead(await res.text(), meta), route);
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status, headers });
}

/**
 * Read from the game server as the visitor who asked: the server limits reads per client address,
 * so a page's lookup counts against that visitor (or crawler), not one bucket every page would share.
 */
function askServer(server: NonNullable<AssetEnv["SERVER"]>, url: URL, path: string, request: Request): Promise<Response> {
  const headers = new Headers({ Accept: "application/json" });
  const address = request.headers.get("cf-connecting-ip");
  if (address) headers.set("cf-connecting-ip", address);
  return server.fetch(new Request(new URL(path, url).toString(), { headers }));
}

/**
 * What the game server says about a player's handle: the handle as its owner writes it, null
 * when nobody has it, undefined when the server could not say (then the page is served as usual).
 */
async function knownHandle(env: AssetEnv, url: URL, handle: string, request: Request): Promise<string | null | undefined> {
  if (!env.SERVER) return undefined;
  try {
    const res = await askServer(env.SERVER, url, `/api/players/${encodeURIComponent(handle)}`, request);
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { player?: { handle?: unknown } };
    return typeof body.player?.handle === "string" ? body.player.handle : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a replay is one a search index may keep: its game was played in public and has ended.
 * Null when the server knows no such game, undefined when it could not say (then it stays unindexed).
 */
async function publicReplay(env: AssetEnv, url: URL, code: string, request: Request): Promise<boolean | null | undefined> {
  if (!env.SERVER) return undefined;
  try {
    const res = await askServer(env.SERVER, url, `/api/games/${encodeURIComponent(code)}`, request);
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return replayIndexable((await res.json()) as Parameters<typeof replayIndexable>[0]);
  } catch {
    return undefined;
  }
}

/**
 * An app page's head and status. A record names its player as they write their handle, so every
 * spelling of it shares one canonical address; a handle nobody has, and a table or replay code
 * that cannot exist, are a 404 that no search index keeps. A table is a room for the people sent
 * its code and is never indexed (nor asked about: its page must not wait on the server). A
 * replay is indexed once its game has ended, when the game was public: it is listed in the games
 * room already, and reads as a page of its own.
 */
async function appPage(env: AssetEnv, url: URL, path: string, route: RouteMatch, request: Request): Promise<{ meta: PageMeta; status: number }> {
  const meta = metaFor(path);
  const missing = { meta: { ...meta, index: false }, status: 404 };
  if (route.name === "game" || route.name === "replay") {
    const code = (route.params["code"] ?? "").toUpperCase();
    if (!isGameCode(code)) return missing;
    if (route.name === "game") return { meta, status: 200 };
    const listed = await publicReplay(env, url, code, request);
    if (listed === null) return missing;
    return { meta: { ...meta, index: listed === true }, status: 200 };
  }
  if (route.name === "profile") {
    const handle = await knownHandle(env, url, route.params["handle"] ?? "", request);
    if (handle === null) return missing;
    if (handle) return { meta: metaFor(`/u/${encodeURIComponent(handle)}`), status: 200 };
  }
  return { meta, status: 200 };
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
  // A crawler may read the API to draw a page (robots.txt lets it), but never keeps an answer as a page.
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}

/** A table's share card: `/share/g/K7Q2XZ.png`. */
const SHARE_CARD = /^\/share\/g\/([A-Za-z0-9]{6})\.png$/;

/** How long a link preview may keep a table's card: a phase moves on in minutes at the fastest. */
const CARD_MAX_AGE = 300;

const png = (body: Uint8Array | ReadableStream | null, maxAge: number, status = 200) =>
  new Response(body as BodyInit | null, { status, headers: { "Content-Type": "image/png", "Cache-Control": `public, max-age=${maxAge}` } });

/**
 * The card for one table (agent/share-card.ts): the neutral board recoloured with the supply
 * centres its saved game holds now. A code that cannot exist, or that names no game, is a 404; a
 * server that cannot say gets the neutral board for a minute rather than a broken preview.
 */
async function tableCard(env: AssetEnv, url: URL, code: string, request: Request): Promise<Response> {
  if (!isGameCode(code)) return notFound(env, url, request, false);
  const base = await fetchAsset(env, url, "/share/board.png", request);
  if (base.status !== 200) return base;
  const bytes = new Uint8Array(await base.arrayBuffer());
  if (!env.SERVER) return png(bytes, 60);
  try {
    // The server limits reads per client address, so the card's read counts against the visitor
    // (or the link previewer) who asked for it, not one bucket every card would share.
    const headers = new Headers({ Accept: "application/json" });
    const address = request.headers.get("cf-connecting-ip");
    if (address) headers.set("cf-connecting-ip", address);
    const res = await env.SERVER.fetch(new Request(new URL(`/api/games/${code}/centres`, url).toString(), { headers }));
    if (res.status === 404) return png(bytes, 60, 404);
    const centres = res.ok ? centresOf(await res.json()) : null;
    return centres ? png(shareCard(bytes, centres), CARD_MAX_AGE) : png(bytes, 60);
  } catch {
    return png(bytes, 60);
  }
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

  const card = SHARE_CARD.exec(path);
  if (card) return tableCard(env, url, card[1]!.toUpperCase(), request);

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
      const route = matchRoute(path)!;
      const { meta, status } = await appPage(env, url, path, route, request);
      const res = withNegotiationHeaders(await withPageHead(shell, path, meta, status, route.name));
      // Tables, and replays of games that were not public, are for the people sent the code.
      if (!meta.index) res.headers.set("X-Robots-Tag", "noindex");
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
