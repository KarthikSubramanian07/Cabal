import { type APIRequestContext, expect, test } from "@playwright/test";

/** What a crawler or a link preview reads: the HTML as the edge sends it, before any script. */
async function head(request: APIRequestContext, path: string) {
  const res = await request.get(path, { headers: { Accept: "text/html" } });
  const html = await res.text();
  const pick = (re: RegExp) => re.exec(html)?.[1] ?? null;
  return {
    status: res.status(),
    robotsHeader: res.headers()["x-robots-tag"] ?? null,
    title: pick(/<title>([^<]*)<\/title>/),
    description: pick(/<meta name="description" content="([^"]*)"/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"/),
    robots: pick(/<meta name="robots" content="([^"]*)"/),
    ogUrl: pick(/<meta property="og:url" content="([^"]*)"/),
    ogTitle: pick(/<meta property="og:title" content="([^"]*)"/),
    ogImage: pick(/<meta property="og:image" content="([^"]*)"/),
    twitterCard: pick(/<meta name="twitter:card" content="([^"]*)"/),
    titles: (html.match(/<title>/g) ?? []).length,
    jsonLd: [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as { "@graph": { "@type": string | string[] }[] }),
  };
}

test.describe("search and sharing", () => {
  // One run is enough for what reads HTML rather than a screen.
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop" && !info.title.includes("router"), "read once, on desktop"));

  const pages: [string, RegExp, boolean][] = [
    ["/", /^Cabal — Diplomacy in your browser/, true],
    ["/sandbox", /^Sandbox: order all seven powers — Cabal$/, true],
    ["/games", /^The games room — Cabal$/, true],
    ["/ledger", /^The Ledger: who keeps their word — Cabal$/, true],
    ["/u/kestrel", /^kestrel — Cabal$/, true],
    ["/g/K7Q2XZ", /^Table K7Q 2XZ — Cabal$/, false],
    ["/replay/K7Q2XZ", /^Replay of table K7Q 2XZ — Cabal$/, false],
  ];

  for (const [path, title, indexed] of pages) {
    test(`${path} carries its own title, description, canonical address and share card`, async ({ request }) => {
      const h = await head(request, path);
      expect(h.status).toBe(200);
      expect(h.title).toMatch(title);
      expect(h.titles).toBe(1);
      expect(h.description?.length).toBeGreaterThan(60);
      expect(h.canonical).toBe(`https://playcabal.pages.dev${path}`);
      expect(h.ogUrl).toBe(h.canonical);
      expect(h.ogTitle).toBe(h.title);
      // A table and its replay show their own board; every other page the site's card.
      const code = /^\/(?:g|replay)\/([A-Z0-9]{6})$/.exec(path)?.[1];
      expect(h.ogImage).toBe(code ? `https://playcabal.pages.dev/share/g/${code}.png` : "https://playcabal.pages.dev/og.png");
      expect(h.twitterCard).toBe("summary_large_image");
      expect(h.robots).toBe(indexed ? "index, follow" : "noindex, follow");
      expect(h.robotsHeader).toBe(indexed ? null : "noindex");
    });
  }

  test("the site describes itself in JSON-LD", async ({ request }) => {
    const h = await head(request, "/");
    const types = h.jsonLd.flatMap((d) => d["@graph"].map((n) => n["@type"]));
    expect(types).toContainEqual("WebSite");
    expect(types).toContainEqual("Organization");
    expect(types).toContainEqual(["VideoGame", "SoftwareApplication"]);
  });

  test("the share card is a 1200 by 630 PNG", async ({ request }) => {
    const res = await request.get("/og.png");
    expect(res.status()).toBe(200);
    const png = await res.body();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  test("robots.txt keeps crawlers off the API and points at the sitemap, which lists the public pages", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://playcabal.pages.dev/sitemap.xml");
    const sitemap = await (await request.get("/sitemap.xml")).text();
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(urls).toEqual(
      ["/", "/sandbox", "/games", "/ledger", "/about", "/contact", "/privacy"].map((p) => `https://playcabal.pages.dev${p}`),
    );
  });

  test("the browser keeps the head in step as the router moves", async ({ page }, info) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try the sandbox" }).click();
    await expect(page).toHaveTitle("Sandbox: order all seven powers — Cabal");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://playcabal.pages.dev/sandbox");
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", "https://playcabal.pages.dev/sandbox");
    if (info.project.name === "phone") await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Ledger" }).click();
    await expect(page).toHaveTitle("The Ledger: who keeps their word — Cabal");
    expect(await page.locator('meta[name="robots"]').count()).toBe(1);
  });
});
