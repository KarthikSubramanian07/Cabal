#!/usr/bin/env node
/**
 * Post-Vite emit: trust pages, markdown siblings, llms.txt, Pages _worker.js for Accept
 * negotiation + real 404s, and the service worker `sw.js` with this build's precache list.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const site = join(root, "site");
const require = createRequire(import.meta.url);

const SITE = "https://playcabal.pages.dev";

function md(name) {
  return readFileSync(join(site, name), "utf8");
}

function mdToHtmlBody(markdown) {
  // Minimal markdown → HTML for trust pages (headings, paragraphs, lists, links).
  const lines = markdown.trimEnd().split("\n");
  const out = [];
  let list = null;
  const flushList = () => {
    if (!list) return;
    out.push(list.ordered ? "<ol>" : "<ul>");
    for (const item of list.items) out.push(`<li>${inline(item)}</li>`);
    out.push(list.ordered ? "</ol>" : "</ul>");
    list = null;
  };
  const inline = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flushList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("> ")) {
      flushList();
      out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`);
      continue;
    }
    const ul = line.match(/^[-*] (.+)$/);
    if (ul) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    if (line.trim() === "") {
      flushList();
      continue;
    }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return out.join("\n");
}

/** The app's stylesheet, as Vite named it: the trust pages share its tokens, fonts and top bar. */
function appStylesheet() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  // The app shell inlines its stylesheet (vite.config.ts) and records where the file is.
  const href = html.match(/<style data-href="([^"]+\.css)"/)?.[1] ?? html.match(/<link rel="stylesheet"[^>]*href="([^"]+\.css)"/)?.[1];
  if (!href) throw new Error("dist/index.html names no stylesheet; cannot style the trust pages");
  return href;
}

/** The wordmark as inline SVG, from the same paths the app's <Wordmark> draws. */
function wordmarkSvg(height = 22) {
  const mark = JSON.parse(readFileSync(join(root, "src/brand/wordmark.json"), "utf8"));
  const [, , w, h] = mark.viewBox.split(" ").map(Number);
  const width = Math.round(((height * w) / h) * 100) / 100;
  return `<svg class="wordmark" viewBox="${mark.viewBox}" width="${width}" height="${height}" role="img" aria-label="Cabal"><path fill-rule="evenodd" fill="var(--bone)" d="${mark.letters}"/><path fill-rule="evenodd" fill="var(--vermilion, #d94f30)" d="${mark.turnedA}"/></svg>`;
}

/**
 * A static page in the app's frame: the same ink top bar, wordmark and links as
 * src/app/Shell.tsx, and the same footer. There is no script here, so How to play is a link
 * to the board (which opens the dialog) and on a phone the links sit in a row under the bar
 * instead of behind a menu button.
 */
function pageShell({ title, description, canonical, bodyHtml, jsonLd, markdownHref, robots, stylesheet }) {
  const ld = jsonLd ? `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n    </script>` : "";
  const mdHref =
    markdownHref ??
    (canonical.endsWith("/") ? "/index.md" : `${canonical.replace(SITE, "")}/index.md`);
  const current = (path) => (canonical === `${SITE}${path}` ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="describedby" href="/llms.txt" />
    <link rel="alternate" type="text/markdown" href="${mdHref}" />${robots ? `\n    <meta name="robots" content="${robots}" />` : ""}
    <meta name="theme-color" content="#121110" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="${stylesheet ?? appStylesheet()}" />
    ${ld}
  </head>
  <body>
    <div class="app" data-route="page">
      <a class="skip-link" href="#main">Skip to the page</a>
      <header class="topbar static">
        <a class="brand" href="/" aria-label="Cabal home">${wordmarkSvg()}</a>
        <nav aria-label="Site">
          <a href="/games">Games</a>
          <a href="/ledger">Ledger</a>
          <a href="/sandbox">Sandbox</a>
          <a href="/sandbox#how-to-play">How to play</a>
          <a href="/about"${current("/about")}>About</a>
          <a href="/contact"${current("/contact")}>Contact</a>
          <a class="nav-end" href="https://github.com/KarthikSubramanian07/Cabal">GitHub</a>
        </nav>
      </header>
      <main class="prose" id="main" tabindex="-1">
${bodyHtml}
      </main>
      <footer class="footer">
        <span>Diplomacy with receipts.</span>
        <span>Adjudicated in your browser by a Rust engine that passes all 171 DATC cases.</span>
        <span>Board drawn from Natural Earth.</span>
        <span class="footer-links">
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="https://github.com/KarthikSubramanian07/Cabal">Source</a>
        </span>
      </footer>
    </div>
  </body>
</html>
`;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** The authored pages: route, Markdown source, title and description. */
const PAGES = [
  ["/", "home.md", "Cabal — Diplomacy browser game with receipts", "Play classic Diplomacy in the browser with explainable adjudication."],
  ["/about", "about.md", "About Cabal — Diplomacy with receipts", "Cabal is an open-source Diplomacy game in the browser: bots, friends, sealed promises and a DATC-complete adjudicator."],
  ["/contact", "contact.md", "Contact Cabal", "Email and GitHub contact paths for the Cabal Diplomacy project."],
  ["/privacy", "privacy.md", "Privacy — Cabal", "What Cabal keeps about you, on your device and on its server, and why."],
];

function notFoundPage(stylesheet) {
  return pageShell({
    title: "Not found — Cabal",
    description: "That path does not exist on Cabal.",
    canonical: `${SITE}/404`,
    bodyHtml: mdToHtmlBody(md("404.md")),
    jsonLd: null,
    markdownHref: "/404.md",
    robots: "noindex",
    stylesheet,
  });
}

/**
 * One trust page as HTML (`/about`, `/contact`, `/privacy`, or `/404.html`), or null for any
 * other path. The build writes these into `dist`; `vite dev` has no `dist`, so it calls this
 * with the stylesheet's source path and serves the same pages (see vite.config.ts).
 */
export function renderTrustPage(route, stylesheet) {
  if (route === "/404.html") return notFoundPage(stylesheet);
  const page = PAGES.find(([path]) => path === route && path !== "/");
  if (!page) return null;
  const [path, file, title, description] = page;
  return pageShell({ title, description, canonical: `${SITE}${path}`, bodyHtml: mdToHtmlBody(md(file)), jsonLd: null, stylesheet });
}

function writePage(route, markdownFile, title, description) {
  const markdown = md(markdownFile);
  assertMinPlainText(markdownFile, markdown, route === "/" ? 500 : 500);
  const dir = route === "/" ? dist : join(dist, route.replace(/^\//, ""));
  ensureDir(dir);
  const canonical = route === "/" ? `${SITE}/` : `${SITE}${route}`;
  const bodyHtml = mdToHtmlBody(markdown);
  const html = pageShell({ title, description, canonical, bodyHtml, jsonLd: null });
  if (route === "/") {
    // Homepage HTML is the Vite SPA shell; we only emit index.md here.
    writeFileSync(join(dist, "index.md"), markdown);
    return;
  }
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "index.md"), markdown);
}

function enrichIndexHtml() {
  const indexPath = join(dist, "index.html");
  let html = readFileSync(indexPath, "utf8");
  const homeMd = md("home.md");
  const homeBody = mdToHtmlBody(homeMd);

  const organization = {
    "@type": "Organization",
    "@id": `${SITE}/#organization`,
    name: "Cabal",
    url: `${SITE}/`,
    description:
      "Cabal publishes a browser Diplomacy game with a DATC-complete adjudicator and explainable order receipts.",
    sameAs: ["https://github.com/KarthikSubramanian07/Cabal"],
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        url: "https://github.com/KarthikSubramanian07/Cabal/issues",
      },
    ],
    address: {
      "@type": "PostalAddress",
      addressCountry: "US",
      addressLocality: "Berkeley",
      addressRegion: "CA",
    },
  };

  const software = {
    "@type": ["VideoGame", "SoftwareApplication"],
    "@id": `${SITE}/#app`,
    name: "Cabal",
    applicationCategory: "GameApplication",
    operatingSystem: "Web browser",
    url: `${SITE}/`,
    description:
      "Cabal is Diplomacy in the browser: the classic 1901 board against six bots or with friends, orders resolved at once by a DATC-complete Rust/WebAssembly adjudicator, promises sealed in wax, and a public Ledger of who kept their word.",
    genre: ["Strategy", "Board game"],
    gamePlatform: "Web browser",
    playMode: ["MultiPlayer", "SinglePlayer"],
    image: `${SITE}/og.png`,
    screenshot: `${SITE}/og.png`,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    author: { "@id": `${SITE}/#organization` },
  };

  const website = {
    "@type": "WebSite",
    "@id": `${SITE}/#website`,
    name: "Cabal",
    url: `${SITE}/`,
    description: "Play Diplomacy in your browser against bots or friends, seal your promises, and see who keeps their word on the Ledger.",
    inLanguage: "en",
    publisher: { "@id": `${SITE}/#organization` },
  };

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [website, organization, software],
  };

  // Replace legacy VideoGame-only JSON-LD if present; else inject before </head>.
  const ldTag = `    <script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n    </script>`;
  if (html.includes('type="application/ld+json"')) {
    html = html.replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      ldTag.trim(),
    );
  } else {
    html = html.replace("</head>", `${ldTag}\n  </head>`);
  }

  // Title, description, canonical link and share card: the front door's by default; the Pages
  // worker writes each address's own over them as the page goes out (src/app/meta.ts).

  if (!html.includes('rel="describedby"')) {
    html = html.replace(
      '<link rel="canonical"',
      '<link rel="describedby" href="/llms.txt" />\n    <link rel="alternate" type="text/markdown" href="/index.md" />\n    <link rel="canonical"',
    );
  }

  // What a visitor sees before the app's script has run: the top bar and the loading screen,
  // word for word and box for box what src/app/Shell.tsx and PageLoading.tsx draw, so React
  // taking over changes nothing on screen. The page's text follows below the fold, and is
  // all there is for readers without script (see base.css).
  const loading = JSON.parse(readFileSync(join(root, "src/app/loading.json"), "utf8"));
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const shell = `<div class="app prerender" data-route="sandbox">
        <header class="topbar">
          <a class="brand" href="/" aria-label="Cabal home">${wordmarkSvg()}</a>
          <button type="button" class="nav-toggle" aria-expanded="false">Menu</button>
          <nav aria-label="Site" data-open="false">
            <a href="/games">Games</a>
            <a href="/ledger">Ledger</a>
            <a href="/sandbox" aria-current="page">Sandbox</a>
            <button type="button">How to play</button>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
            <a class="nav-end" href="https://github.com/KarthikSubramanian07/Cabal">GitHub</a>
          </nav>
          <div class="player-menu"><button type="button" class="player-button" aria-expanded="false"><span class="player-seal empty" aria-hidden="true"></span><span class="player-name">Your account</span></button></div>
        </header>
        <main class="loading-body">
          <div class="loading-card">
            <p class="loading-title" role="status">${escape(loading.title)}</p>
            <p class="loading-line">${escape(loading.line)}</p>
            <p class="loading-note">${escape(loading.note)}</p>
          </div>
        </main>
      </div>`;

  const article = `<article class="agent-static" data-agent-content="true">
        ${homeBody}
        <p><a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/privacy">Privacy</a> · <a href="/llms.txt">llms.txt</a></p>
      </article>`;

  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, `<noscript>${article}</noscript>`);
  if (!html.includes("<noscript>")) {
    html = html.replace("<body>", `<body>\n    <noscript>${article}</noscript>`);
  }

  // Always replace #root contents with the full home.md article for no-JS crawlers.
  if (html.includes('<div id="root"></div>')) {
    html = html.replace('<div id="root"></div>', () => `<div id="root">\n      ${shell}\n      ${article}\n    </div>`);
  } else {
    html = html.replace(
      /<div id="root">[\s\S]*?<\/div>\s*(?=<script|<\/body>)/,
      () => `<div id="root">\n      ${shell}\n      ${article}\n    </div>\n    `,
    );
  }

  writeFileSync(indexPath, html);

  assertMinPlainText("homepage", homeBody.replace(/<[^>]+>/g, " "), 500);
}

function assertMinPlainText(label, text, min) {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length < min) {
    throw new Error(`${label} text content too short: ${plain.length} chars (need ${min})`);
  }
}

function write404() {
  writeFileSync(join(dist, "404.md"), md("404.md"));
  writeFileSync(join(dist, "404.html"), notFoundPage());
}

function writeLlms() {
  writeFileSync(join(dist, "llms.txt"), md("llms.txt"));
}

/** The pages a search index may keep; tables and replays are reached by their code, not listed. */
export const SITEMAP = [
  ["/", "daily", "1.0"],
  ["/sandbox", "monthly", "0.9"],
  ["/games", "hourly", "0.8"],
  ["/ledger", "daily", "0.8"],
  ["/about", "monthly", "0.6"],
  ["/contact", "yearly", "0.4"],
  ["/privacy", "yearly", "0.4"],
];

function writeSitemap() {
  const urls = SITEMAP.map(([path, freq, priority]) => `  <url><loc>${SITE}${path}</loc><changefreq>${freq}</changefreq><priority>${priority}</priority></url>`);
  writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
}

function loadEsbuild() {
  // Resolve esbuild from wrangler or vite's dependency tree.
  let esbuild;
  const candidates = [
    join(root, "node_modules/esbuild/lib/main.js"),
    join(root, "../../node_modules/esbuild/lib/main.js"),
    join(root, "../../node_modules/.pnpm/node_modules/esbuild/lib/main.js"),
  ];
  try {
    esbuild = require("esbuild");
  } catch {
    for (const c of candidates) {
      if (existsSync(c)) {
        esbuild = require(c);
        break;
      }
    }
  }
  if (!esbuild) {
    // Last resort: use wrangler's bundled esbuild path via dynamic import from vite
    try {
      esbuild = require(require.resolve("esbuild", { paths: [root, join(root, "../..")] }));
    } catch (err) {
      throw new Error(`esbuild not found for bundling _worker.js: ${err}`);
    }
  }

  return esbuild;
}

async function bundleWorker(esbuild) {
  const entry = join(root, "worker/entry.ts");
  await esbuild.build({
    entryPoints: [entry],
    outfile: join(dist, "_worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "info",
  });
}

/** Unhashed files the shell needs offline; keep in step with SHELL_FILES in src/sw/policy.ts. */
const SHELL_FILES = ["/favicon.svg", "/site.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

/**
 * What the service worker stores at install: the app shell exactly as built, the unhashed files it
 * needs offline, and every hashed file under /assets (code, styles, the engine, the fonts).
 */
export function precacheList(distDir) {
  const assets = readdirSync(join(distDir, "assets"))
    .filter((f) => /\.(?:js|css|wasm|woff2)$/.test(f))
    .sort()
    .map((f) => `/assets/${f}`);
  const shell = SHELL_FILES.filter((f) => existsSync(join(distDir, f.slice(1))));
  return ["/index.html", ...shell, ...assets];
}

/**
 * The version is a hash of every precached file's bytes, so any change to what the worker would
 * serve offline ships a byte-different sw.js, and browsers install it and offer the update.
 */
async function bundleServiceWorker(esbuild) {
  const precache = precacheList(dist);
  const hash = createHash("sha256");
  for (const path of precache) hash.update(path).update(readFileSync(join(dist, path.slice(1))));
  const version = hash.digest("hex").slice(0, 16);
  await esbuild.build({
    entryPoints: [join(root, "src/sw/worker.ts")],
    outfile: join(dist, "sw.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { __CABAL_SW__: JSON.stringify({ version, precache }) },
    logLevel: "warning",
  });
  return { version, files: precache.length };
}

/**
 * The front door, prerendered: the app's own markup for `/` (src/landing/prerender.tsx) written into
 * a copy of the shell at dist/landing/index.html, which the Pages worker serves for `/`. The
 * board's preloads are dropped from this copy: the front door has no board, and the engine
 * (a megabyte) must not compete with the headline.
 */
async function writeLanding(esbuild) {
  const out = join(root, "node_modules/.cache/cabal-prerender/landing.mjs");
  await esbuild.build({
    entryPoints: [join(root, "src/landing/prerender.tsx")],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    jsx: "automatic",
    // React's server renderer reaches for Node built-ins with require().
    banner: { js: 'import { createRequire as __cabalRequire } from "node:module"; const require = __cabalRequire(import.meta.url);' },
    loader: { ".css": "empty" },
    // Pages behind the front door are bundled too (their dynamic imports), never run: their
    // asset URLs (the engine's WebAssembly) need only exist.
    plugins: [
      {
        name: "asset-urls",
        setup(build) {
          build.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "asset-url" }));
          build.onLoad({ filter: /.*/, namespace: "asset-url" }, () => ({ contents: 'export default "";', loader: "js" }));
        },
      },
    ],
    define: { "import.meta.env.PROD": "true", "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const { renderLanding } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
  const markup = renderLanding();
  let html = readFileSync(join(dist, "index.html"), "utf8");
  html = html.replace(/\s*<link rel="modulepreload"[^>]*(?:SandboxPage|board)-[^>]*>/g, "");
  html = html.replace(/\s*<link rel="preload" as="fetch"[^>]*cabal_engine_bg-[^>]*>/g, "");
  const start = html.indexOf('<div id="root">');
  const end = html.lastIndexOf("</div>", html.indexOf("</body>"));
  if (start < 0 || end < start) throw new Error("emit-agent-site: no #root in dist/index.html");
  html = `${html.slice(0, start)}<div id="root" data-prerendered="home">${markup}${html.slice(end)}`;
  assertMinPlainText("front door", markup.replace(/<[^>]+>/g, " "), 1500);
  ensureDir(join(dist, "landing"));
  writeFileSync(join(dist, "landing/index.html"), html);
}

async function main() {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error("dist/index.html missing; run vite build first");
  }

  for (const [route, file, title, description] of PAGES) writePage(route, file, title, description);
  write404();
  writeLlms();
  writeSitemap();
  enrichIndexHtml();
  const esbuild = loadEsbuild();
  await writeLanding(esbuild);
  await bundleWorker(esbuild);
  const sw = await bundleServiceWorker(esbuild);
  console.log(`emit-agent-site: wrote trust pages, markdown siblings, llms.txt, _worker.js, sw.js (build ${sw.version}, ${sw.files} files precached)`);
}

// Run as a script (the build); imported for `renderTrustPage` by the dev server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
