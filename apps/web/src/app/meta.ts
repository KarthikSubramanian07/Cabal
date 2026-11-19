/**
 * What each address says about itself: title, description, canonical URL, whether a search
 * index may keep it, and the share card. Pure, and shared by the Pages worker (which writes it
 * into the app shell's <head> before the page leaves the edge, so crawlers and link previews
 * that never run script still read the right card) and the browser (which keeps <head> in step
 * as the router moves between pages).
 */
import { type RouteMatch, matchRoute } from "./routes.js";

export const SITE = "https://playcabal.pages.dev";
export const SHARE_IMAGE = `${SITE}/og.png`;
export const SHARE_IMAGE_ALT = "Seven wax seals in the colours of the great powers on an ink table, one of them cracked, beside the Cabal wordmark.";

export interface PageMeta {
  /** The whole <title>, brand included. */
  title: string;
  description: string;
  /** Absolute canonical URL. */
  canonical: string;
  /** False keeps the page out of search indexes (`noindex`); links on it are still followed. */
  index: boolean;
  /** `website` for the front door, `article` for pages about one player or one game. */
  type: "website" | "article";
}

const BRAND = "Cabal";

/** Six-character codes read better split in two: K7Q 2XZ. */
function spaced(code: string): string {
  const c = code.toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

export function metaForRoute(route: RouteMatch | null, path: string): PageMeta {
  const canonical = `${SITE}${path === "/" ? "/" : path.replace(/\/$/, "")}`;
  if (!route) {
    return { title: `Not found — ${BRAND}`, description: "That address is not on Cabal.", canonical, index: false, type: "website" };
  }
  const p = route.params;
  switch (route.name) {
    case "home":
      return {
        title: "Cabal — Diplomacy in your browser, with sealed promises and AI rivals",
        description:
          "Play Diplomacy on the classic 1901 board against six bots in under a minute, or set a table for friends. Seal your promises in wax; the Ledger shows who kept them.",
        canonical: `${SITE}/`,
        index: true,
        type: "website",
      };
    case "sandbox":
      return {
        title: `Sandbox: order all seven powers — ${BRAND}`,
        description:
          "Every power on the 1901 board is yours to order. Write moves on the map, resolve the phase in your browser and read why each order succeeded or failed.",
        canonical,
        index: true,
        type: "website",
      };
    case "games":
      return {
        title: `The games room — ${BRAND}`,
        description: "Open Diplomacy tables waiting for players and public games in play. Take a seat, watch, or set a table of your own.",
        canonical,
        index: true,
        type: "website",
      };
    case "ledger":
      return {
        title: `The Ledger: who keeps their word — ${BRAND}`,
        description: "Cabal's standings: players ranked by the promises they kept and broke across every game, and by rating.",
        canonical,
        index: true,
        type: "website",
      };
    case "profile": {
      const handle = p["handle"] ?? "";
      return {
        title: `${handle} — ${BRAND}`,
        description: `${handle}'s record on Cabal: rating, how reliably they order, the promises they kept and broke, and their recent games.`,
        canonical: `${SITE}/u/${encodeURIComponent(handle)}`,
        index: true,
        type: "article",
      };
    }
    case "game": {
      const code = spaced(p["code"] ?? "");
      return {
        title: `Table ${code} — ${BRAND}`,
        description: `A seat is waiting at Diplomacy table ${code}. Seven powers, orders written in secret, promises sealed in wax.`,
        canonical,
        // A table is a private room for its players; its code is shared on purpose, not published.
        index: false,
        type: "article",
      };
    }
    case "replay": {
      const code = spaced(p["code"] ?? "");
      return {
        title: `Replay of table ${code} — ${BRAND}`,
        description: `Every phase of Diplomacy table ${code}, played back on the board with each order's result and every sealed promise opened.`,
        canonical,
        index: false,
        type: "article",
      };
    }
  }
}

export function metaFor(path: string): PageMeta {
  return metaForRoute(matchRoute(path), path);
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Write a page's meta into an HTML document's <head>: the title, description, canonical link,
 * robots, and the OpenGraph and Twitter tags. Tags already present are replaced in place; missing
 * ones are added before </head>.
 */
export function writeHead(html: string, meta: PageMeta): string {
  const tags: [RegExp, string][] = [
    [/<title>[^<]*<\/title>/, `<title>${escapeAttr(meta.title)}</title>`],
    [/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeAttr(meta.description)}" />`],
    [/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escapeAttr(meta.canonical)}" />`],
    [/<meta name="robots"[^>]*>/, `<meta name="robots" content="${meta.index ? "index, follow" : "noindex, follow"}" />`],
    [/<meta property="og:type"[^>]*>/, `<meta property="og:type" content="${meta.type}" />`],
    [/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${escapeAttr(meta.canonical)}" />`],
    [/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escapeAttr(meta.title)}" />`],
    [/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escapeAttr(meta.description)}" />`],
    [/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`],
    [/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`],
  ];
  let out = html;
  const missing: string[] = [];
  for (const [pattern, tag] of tags) {
    if (pattern.test(out)) out = out.replace(pattern, () => tag);
    else missing.push(tag);
  }
  if (missing.length) out = out.replace("</head>", () => `    ${missing.join("\n    ")}\n  </head>`);
  return out;
}

/** Keep the live document's <head> in step with a page's meta (the browser side of writeHead). */
export function applyHead(meta: PageMeta, doc: Document = document): void {
  doc.title = meta.title;
  const set = (selector: string, make: () => HTMLElement, attr: string, value: string) => {
    let el = doc.head.querySelector<HTMLElement>(selector);
    if (!el) {
      el = make();
      doc.head.append(el);
    }
    el.setAttribute(attr, value);
  };
  const meta$ = (key: "name" | "property", name: string) => () => {
    const m = doc.createElement("meta");
    m.setAttribute(key, name);
    return m;
  };
  set('meta[name="description"]', meta$("name", "description"), "content", meta.description);
  set('meta[name="robots"]', meta$("name", "robots"), "content", meta.index ? "index, follow" : "noindex, follow");
  set(
    'link[rel="canonical"]',
    () => {
      const l = doc.createElement("link");
      l.rel = "canonical";
      return l;
    },
    "href",
    meta.canonical,
  );
  set('meta[property="og:type"]', meta$("property", "og:type"), "content", meta.type);
  set('meta[property="og:url"]', meta$("property", "og:url"), "content", meta.canonical);
  set('meta[property="og:title"]', meta$("property", "og:title"), "content", meta.title);
  set('meta[property="og:description"]', meta$("property", "og:description"), "content", meta.description);
  set('meta[name="twitter:title"]', meta$("name", "twitter:title"), "content", meta.title);
  set('meta[name="twitter:description"]', meta$("name", "twitter:description"), "content", meta.description);
}
