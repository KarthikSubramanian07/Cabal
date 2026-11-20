/**
 * The route table. Pure data and matching, shared by the browser router and the Pages
 * worker (src/agent/gateway.ts), so the edge serves the app shell for exactly the paths
 * the client can render and a real 404 for everything else.
 */

export type RouteName = "home" | "sandbox" | "game" | "games" | "ledger" | "profile" | "replay" | "status";

export interface RouteDef {
  name: RouteName;
  /** Path pattern. A `:name` segment captures one identifier. */
  pattern: string;
}

export const ROUTES: readonly RouteDef[] = [
  { name: "home", pattern: "/" },
  { name: "sandbox", pattern: "/sandbox" },
  { name: "games", pattern: "/games" },
  { name: "game", pattern: "/g/:code" },
  { name: "ledger", pattern: "/ledger" },
  { name: "profile", pattern: "/u/:handle" },
  { name: "replay", pattern: "/replay/:code" },
  { name: "status", pattern: "/status" },
];

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
}

/** Game codes and handles: letters, digits, dash and underscore, at most 64 characters. */
const PARAM = /^[A-Za-z0-9_-]{1,64}$/;

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Match a pathname against the route table. Trailing slashes are ignored. */
export function matchRoute(pathname: string): RouteMatch | null {
  const parts = segments(pathname);
  for (const route of ROUTES) {
    const want = segments(route.pattern);
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const got = parts[i]!;
      if (w.startsWith(":")) {
        if (!PARAM.test(got)) ok = false;
        else params[w.slice(1)] = got;
      } else if (w !== got) {
        ok = false;
      }
      if (!ok) break;
    }
    if (ok) return { name: route.name, params };
  }
  return null;
}

/** Build a path for a route, for links. */
export function pathFor(name: RouteName, params: Record<string, string> = {}): string {
  const route = ROUTES.find((r) => r.name === name);
  if (!route) return "/";
  return route.pattern.replace(/:([a-z]+)/g, (_, key: string) => encodeURIComponent(params[key] ?? ""));
}
