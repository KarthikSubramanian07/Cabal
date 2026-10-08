import {
  appendVaryAccept,
  markdownPath,
  normalizePath,
  preferredType,
} from "./negotiate.js";

export interface AssetEnv {
  ASSETS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

/** Paths that have authored HTML + Markdown content (not the SPA shell alone). */
export const CONTENT_ROUTES = new Set(["/", "/about", "/contact", "/privacy"]);

const STATIC_EXT =
  /\.(?:html?|css|js|mjs|map|png|jpe?g|webp|gif|svg|avif|ico|woff2?|ttf|otf|eot|xml|txt|json|webmanifest|wasm|md|pdf)$/i;

export function isStaticAsset(pathname: string): boolean {
  return STATIC_EXT.test(pathname);
}

function htmlAssetPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === "/") return "/index.html";
  return `${path}/index.html`;
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

export async function handleAgentRequest(request: Request, env: AssetEnv): Promise<Response> {
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

  const wantsMarkdown = chosen === "text/markdown";
  const isContent = CONTENT_ROUTES.has(path);

  if (wantsMarkdown) {
    if (!isContent) {
      return notFound(env, url, request, true);
    }
    const mdRes = await fetchAsset(env, url, markdownPath(path), request);
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

  if (!isContent) {
    return notFound(env, url, request, false);
  }

  const htmlRes = await fetchAsset(env, url, htmlAssetPath(path), request);
  if (htmlRes.status !== 200) {
    return notFound(env, url, request, false);
  }

  const res = withNegotiationHeaders(htmlRes);
  const linkMd = `<${markdownPath(path)}>; rel="alternate"; type="text/markdown"`;
  const linkLlms = `</llms.txt>; rel="describedby"`;
  const existing = res.headers.get("link");
  res.headers.set("Link", existing ? `${existing}, ${linkMd}, ${linkLlms}` : `${linkMd}, ${linkLlms}`);
  return res;
}
