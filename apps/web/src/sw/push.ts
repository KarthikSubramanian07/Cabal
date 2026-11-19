/**
 * What the service worker shows for a push message, and where a click on it goes. Pure, so it is
 * tested without a browser. The payload (`PushPayload` in @cabal/protocol) never carries orders or
 * press text: only enough to say what happened and where to look.
 */

export interface ShownNotification {
  title: string;
  options: { body: string; tag: string; icon: string; badge: string; data: { url: string }; renotify: boolean; timestamp: number };
}

const KINDS = new Set(["deadline", "phase", "press", "started", "finished"]);

/** Keep a click inside this site: a path on this origin, or the front door. */
export function clickTarget(url: unknown, origin: string): string {
  if (typeof url !== "string") return "/";
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? parsed.pathname + parsed.search : "/";
  } catch {
    return "/";
  }
}

export function notificationFor(data: unknown, origin: string): ShownNotification | null {
  if (!data || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  if (typeof p["title"] !== "string" || typeof p["body"] !== "string" || !KINDS.has(String(p["kind"]))) return null;
  const tag = typeof p["tag"] === "string" && p["tag"] ? p["tag"] : `cabal-${String(p["kind"])}`;
  return {
    title: p["title"].slice(0, 120),
    options: {
      body: p["body"].slice(0, 240),
      tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: clickTarget(p["url"], origin) },
      // A later message about the same thing replaces the earlier one, and says so.
      renotify: true,
      timestamp: typeof p["sentAt"] === "number" ? p["sentAt"] : Date.now(),
    },
  };
}

/** The window to bring forward for a click: one already on that page, else any of this site's. */
export function pickClient<T extends { url: string }>(clients: readonly T[], path: string, origin: string): { client: T; navigate: boolean } | null {
  const exact = clients.find((c) => clickTarget(c.url, origin) === path);
  if (exact) return { client: exact, navigate: false };
  const any = clients.find((c) => c.url.startsWith(origin));
  return any ? { client: any, navigate: true } : null;
}
