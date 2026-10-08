#!/usr/bin/env node
/**
 * Post-Vite emit: trust pages, markdown siblings, llms.txt, and Pages _worker.js
 * for Accept negotiation + real 404s.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");
const site = join(root, "site");
const require = createRequire(import.meta.url);

const SITE = "https://playcabal.pages.dev";
const EMAIL = "winnerkarthik07@gmail.com";

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

function pageShell({ title, description, canonical, bodyHtml, jsonLd, markdownHref }) {
  const ld = jsonLd ? `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n    </script>` : "";
  const mdHref =
    markdownHref ??
    (canonical.endsWith("/") ? "/index.md" : `${canonical.replace(SITE, "")}/index.md`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="describedby" href="/llms.txt" />
    <link rel="alternate" type="text/markdown" href="${mdHref}" />
    <meta name="theme-color" content="#121110" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme: light; --ink:#121110; --ink-3:#5f5a53; --bone:#f4f0e6; --paper:#fbf9f4; --rule:#d3cab5; --brass-deep:#94731f; --font-ui: "Inter Tight", system-ui, sans-serif; --font-display: "Archivo Black", "Arial Black", sans-serif; }
      * { box-sizing: border-box; }
      body { margin:0; background:var(--bone); color:var(--ink); font-family:var(--font-ui); font-size:16px; line-height:1.55; }
      a { color: inherit; }
      .wrap { max-width: 42rem; margin: 0 auto; padding: 1.25rem 1.25rem 3rem; }
      header.site { display:flex; justify-content:space-between; gap:1rem; align-items:baseline; padding: 0.85rem 0 1.25rem; border-bottom:1px solid var(--rule); margin-bottom:1.5rem; }
      header.site a.brand { font-family:var(--font-display); letter-spacing:0.04em; text-decoration:none; font-size:1.1rem; }
      nav { display:flex; flex-wrap:wrap; gap:0.85rem; font-size:0.92rem; color:var(--ink-3); }
      nav a[aria-current="page"] { color:var(--ink); text-decoration:underline; text-underline-offset:3px; }
      h1 { font-family:var(--font-display); font-size:clamp(1.8rem, 4vw, 2.4rem); line-height:1.1; text-wrap:balance; margin:0 0 0.75rem; }
      h2 { font-size:1.15rem; margin:1.75rem 0 0.5rem; }
      p, li { color:var(--ink); }
      blockquote { margin:0 0 1rem; padding:0.75rem 1rem; background:var(--paper); border:1px solid var(--rule); }
      blockquote p { margin:0; color:var(--ink-3); }
      ul, ol { padding-left: 1.2rem; }
      footer { margin-top:2.5rem; padding-top:1rem; border-top:1px solid var(--rule); color:var(--ink-3); font-size:0.9rem; display:flex; flex-wrap:wrap; gap:0.75rem; }
    </style>
    ${ld}
  </head>
  <body>
    <div class="wrap">
      <header class="site">
        <a class="brand" href="/">CABAL</a>
        <nav>
          <a href="/">Sandbox</a>
          <a href="/about"${canonical.includes("/about") ? ' aria-current="page"' : ""}>About</a>
          <a href="/contact"${canonical.includes("/contact") ? ' aria-current="page"' : ""}>Contact</a>
          <a href="/privacy"${canonical.includes("/privacy") ? ' aria-current="page"' : ""}>Privacy</a>
        </nav>
      </header>
      <main>
${bodyHtml}
      </main>
      <footer>
        <span>Diplomacy with receipts.</span>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://github.com/KarthikSubramanian07/Cabal">GitHub</a>
        <a href="mailto:${EMAIL}">${EMAIL}</a>
      </footer>
    </div>
  </body>
</html>
`;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
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
    email: EMAIL,
    description:
      "Cabal publishes a browser Diplomacy game with a DATC-complete adjudicator and explainable order receipts.",
    sameAs: ["https://github.com/KarthikSubramanian07/Cabal"],
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: EMAIL,
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
    "@type": "SoftwareApplication",
    "@id": `${SITE}/#app`,
    name: "Cabal",
    applicationCategory: "GameApplication",
    operatingSystem: "Web browser",
    url: `${SITE}/`,
    description:
      "Cabal is a Diplomacy browser game with receipts: classic 1901 board, simultaneous orders, and a DATC-complete Rust/WebAssembly adjudicator.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    author: { "@id": `${SITE}/#organization` },
  };

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [organization, software],
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

  // Brand-forward title for discoverability (Diplomacy + Cabal).
  html = html.replace(
    /<title>[^<]*<\/title>/,
    "<title>Cabal — Diplomacy browser game with receipts</title>",
  );
  html = html.replace(
    /property="og:title" content="[^"]*"/,
    'property="og:title" content="Cabal — Diplomacy browser game with receipts"',
  );
  html = html.replace(
    /name="twitter:title" content="[^"]*"/,
    'name="twitter:title" content="Cabal — Diplomacy browser game with receipts"',
  );

  if (!html.includes('rel="describedby"')) {
    html = html.replace(
      '<link rel="canonical"',
      '<link rel="describedby" href="/llms.txt" />\n    <link rel="alternate" type="text/markdown" href="/index.md" />\n    <link rel="canonical"',
    );
  }

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
    html = html.replace('<div id="root"></div>', `<div id="root">\n      ${article}\n    </div>`);
  } else {
    html = html.replace(
      /<div id="root">[\s\S]*?<\/div>\s*(?=<script|<\/body>)/,
      `<div id="root">\n      ${article}\n    </div>\n    `,
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
  const markdown = md("404.md");
  writeFileSync(join(dist, "404.md"), markdown);
  const html = pageShell({
    title: "Not found — Cabal",
    description: "That path does not exist on Cabal.",
    canonical: `${SITE}/404`,
    bodyHtml: mdToHtmlBody(markdown),
    jsonLd: null,
    markdownHref: "/404.md",
  });
  writeFileSync(join(dist, "404.html"), html);
}

function writeLlms() {
  writeFileSync(join(dist, "llms.txt"), md("llms.txt"));
}

function writeSitemap() {
  writeFileSync(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE}/about</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>${SITE}/contact</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>${SITE}/privacy</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${SITE}/llms.txt</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
</urlset>
`,
  );
}

async function bundleWorker() {
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

async function main() {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error("dist/index.html missing; run vite build first");
  }

  writePage("/", "home.md", "Cabal — Diplomacy browser game with receipts", "Play classic Diplomacy in the browser with explainable adjudication.");
  writePage(
    "/about",
    "about.md",
    "About Cabal — Diplomacy with receipts",
    "Cabal is an open-source Diplomacy browser game with a DATC-complete adjudicator.",
  );
  writePage(
    "/contact",
    "contact.md",
    "Contact Cabal",
    "Email and GitHub contact paths for the Cabal Diplomacy project.",
  );
  writePage(
    "/privacy",
    "privacy.md",
    "Privacy — Cabal",
    "How the Cabal Diplomacy sandbox handles information in your browser.",
  );
  write404();
  writeLlms();
  writeSitemap();
  enrichIndexHtml();
  await bundleWorker();
  console.log("emit-agent-site: wrote trust pages, markdown siblings, llms.txt, _worker.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
