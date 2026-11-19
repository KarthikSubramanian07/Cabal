import { describe, expect, it } from "vitest";
import { type CacheLike, type CacheStorageLike, createWorker } from "./handlers.js";
import { cacheable, classify, shellServes, staleCaches } from "./policy.js";

const ORIGIN = "https://playcabal.pages.dev";
const at = (path: string) => `${ORIGIN}${path}`;
const get = (path: string, mode = "cors", accept = "*/*") => ({ method: "GET", url: at(path), mode, accept });

describe("what the worker touches", () => {
  it("never touches the API, sockets included, or anything that is not a same-origin GET", () => {
    expect(classify(get("/api/games?status=open"), ORIGIN)).toBe("pass");
    expect(classify(get("/api/games/K7Q2XZ/ws"), ORIGIN)).toBe("pass");
    expect(classify(get("/api"), ORIGIN)).toBe("pass");
    expect(classify({ ...get("/api/games"), method: "POST" }, ORIGIN)).toBe("pass");
    expect(classify({ ...get("/assets/index-abc.js"), url: "https://cdn.example.com/assets/x.js" }, ORIGIN)).toBe("pass");
    expect(classify(get("/sw.js"), ORIGIN)).toBe("pass");
  });

  it("leaves Markdown negotiation to the edge", () => {
    expect(classify(get("/about", "navigate", "text/markdown, text/html;q=0.5"), ORIGIN)).toBe("pass");
    expect(classify(get("/", "navigate", "text/html,application/xhtml+xml,*/*;q=0.8"), ORIGIN)).toBe("navigate");
  });

  it("sorts navigations, hashed assets and the shell's own files", () => {
    expect(classify(get("/g/K7Q2XZ", "navigate"), ORIGIN)).toBe("navigate");
    expect(classify(get("/assets/board-9f8e.js"), ORIGIN)).toBe("asset");
    expect(classify(get("/site.webmanifest"), ORIGIN)).toBe("static");
    expect(classify(get("/og.png"), ORIGIN)).toBe("pass");
    expect(classify(get("/llms.txt"), ORIGIN)).toBe("pass");
  });

  it("offers the shell offline only for the app's own routes", () => {
    expect(shellServes(at("/"))).toBe(true);
    expect(shellServes(at("/g/K7Q2XZ"))).toBe(true);
    expect(shellServes(at("/games"))).toBe(true);
    expect(shellServes(at("/about"))).toBe(false);
    expect(shellServes(at("/nope/nope"))).toBe(false);
  });

  it("keeps only complete, successful, same-origin answers", () => {
    expect(cacheable({ ok: true, status: 200, type: "basic" })).toBe(true);
    expect(cacheable({ ok: false, status: 404, type: "basic" })).toBe(false);
    expect(cacheable({ ok: false, status: 503, type: "basic" })).toBe(false);
    expect(cacheable({ ok: true, status: 206, type: "basic" })).toBe(false);
    expect(cacheable({ ok: false, status: 0, type: "opaque" })).toBe(false);
    expect(cacheable({ ok: true, status: 200, type: "basic", redirected: true })).toBe(false);
  });

  it("clears every other build's cache and nobody else's", () => {
    expect(staleCaches(["cabal-a", "cabal-b", "cabal-shell-v1", "other"], "b")).toEqual(["cabal-a", "cabal-shell-v1"]);
  });
});

class MemoryCache implements CacheLike {
  readonly map = new Map<string, Response>();
  /** Requests whose stored copy varies by Origin: a match without `ignoreVary` misses them. */
  readonly varyOrigin = new Set<string>();
  async match(request: Request | string, options: { ignoreVary?: boolean } = {}) {
    const url = typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
    const sentOrigin = typeof request !== "string" && request.headers.has("origin");
    if (this.varyOrigin.has(url) && sentOrigin && !options.ignoreVary) return undefined;
    return this.map.get(url)?.clone();
  }
  async put(request: Request | string, response: Response) {
    this.map.set(typeof request === "string" ? new URL(request, ORIGIN).href : request.url, response);
  }
  async addAll(requests: (Request | string)[]) {
    for (const r of requests) {
      const url = typeof r === "string" ? new URL(r, ORIGIN).href : r.url;
      this.map.set(url, new Response(`stored ${new URL(url).pathname}`, { status: 200 }));
    }
  }
}

class MemoryCaches implements CacheStorageLike {
  readonly stores = new Map<string, MemoryCache>();
  async open(name: string) {
    let c = this.stores.get(name);
    if (!c) this.stores.set(name, (c = new MemoryCache()));
    return c;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** A Request as the browser hands it to the worker. Node's Request cannot be built in navigate mode. */
function request(path: string, mode = "cors"): Request {
  return { method: "GET", url: at(path), mode, headers: new Headers({ accept: mode === "navigate" ? "text/html" : "*/*" }), clone() { return this; } } as unknown as Request;
}

function basic(body: string, status = 200): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
}

function setup(network: (url: string) => Response | Promise<Response>) {
  const caches = new MemoryCaches();
  const calls: string[] = [];
  const worker = createWorker({
    version: "v2",
    precache: ["/index.html", "/assets/index-abc.js"],
    caches,
    origin: ORIGIN,
    fetch: async (r) => {
      const url = typeof r === "string" ? r : r.url;
      calls.push(new URL(url).pathname);
      return network(url);
    },
  });
  return { caches, calls, worker };
}

describe("the worker's answers", () => {
  it("installs this build's shell and assets, and clears older builds on activate", async () => {
    const { caches, worker } = setup(() => basic("x"));
    await caches.open("cabal-v1");
    await caches.open("cabal-shell-v1");
    await worker.install();
    await worker.activate();
    expect(await caches.keys()).toEqual(["cabal-v2"]);
    expect([...caches.stores.get("cabal-v2")!.map.keys()]).toEqual([at("/index.html"), at("/assets/index-abc.js")]);
  });

  it("goes to the network for every navigation while it is up, never to the stored shell", async () => {
    const { worker, calls } = setup(() => basic("<title>DEPLOY-2</title>"));
    await worker.install();
    const res = await worker.respond(request("/g/K7Q2XZ", "navigate"))!;
    expect(await res.text()).toBe("<title>DEPLOY-2</title>");
    expect(calls).toEqual(["/g/K7Q2XZ"]);
  });

  it("answers an app route with the installed shell only when the network is down", async () => {
    const { worker } = setup(() => {
      throw new TypeError("offline");
    });
    await worker.install();
    expect(await (await worker.respond(request("/games", "navigate"))!).text()).toBe("stored /index.html");
    await expect(worker.respond(request("/about", "navigate"))!).rejects.toThrow("offline");
  });

  it("serves a stored hashed file to a module script that sends an Origin, offline", async () => {
    const { worker, caches } = setup(() => {
      throw new TypeError("offline");
    });
    await worker.install();
    (await caches.open("cabal-v2")).varyOrigin.add(at("/assets/index-abc.js"));
    const moduleScript = new Request(at("/assets/index-abc.js"), { headers: { origin: ORIGIN } });
    expect(await (await worker.respond(moduleScript))!.text()).toBe("stored /assets/index-abc.js");
  });

  it("does not store a 404, and asks the network again next time", async () => {
    let status = 404;
    const { worker, calls, caches } = setup(() => basic(status === 200 ? "code" : "missing", status));
    const first = await worker.respond(request("/assets/board-def.js"))!;
    expect(first.status).toBe(404);
    expect(await (await caches.open("cabal-v2")).match(at("/assets/board-def.js"))).toBeUndefined();
    status = 200;
    expect(await (await worker.respond(request("/assets/board-def.js"))!).text()).toBe("code");
    // Now it is stored: the third ask never reaches the network.
    expect(await (await worker.respond(request("/assets/board-def.js"))!).text()).toBe("code");
    expect(calls).toEqual(["/assets/board-def.js", "/assets/board-def.js"]);
  });

  it("never answers an API call, online or off", async () => {
    const { worker } = setup(() => {
      throw new TypeError("offline");
    });
    await worker.install();
    expect(worker.respond(request("/api/games/ZZZZZZ"))).toBeNull();
    expect(worker.respond(request("/never-seen.png"))).toBeNull();
  });

  it("serves the manifest from the network, falling back to the installed copy", async () => {
    let up = true;
    const { worker, caches } = setup(() => {
      if (!up) throw new TypeError("offline");
      return basic("fresh manifest");
    });
    await (await caches.open("cabal-v2")).addAll(["/site.webmanifest"]);
    expect(await (await worker.respond(request("/site.webmanifest"))!).text()).toBe("fresh manifest");
    up = false;
    expect(await (await worker.respond(request("/site.webmanifest"))!).text()).toBe("stored /site.webmanifest");
  });
});
