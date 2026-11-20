/**
 * Reporting a page that broke (`POST /api/errors`, issue #12), so a failure players meet reaches
 * the server's logs and not only their console. A report names the kind of failure, its message,
 * the page by route name (never the address, which can hold a game code or a handle) and the
 * stack's top frame without the origin. Nothing names the player or the device; the privacy page
 * says so.
 *
 * At most `MAX_REPORTS` go from one page load, and the same failure goes once: a render loop or a
 * timer that throws every second must not become a flood. Every browser API is optional; a report
 * that cannot be sent is let go.
 */
import type { ClientErrorReport } from "@cabal/protocol";
import { matchRoute } from "../app/routes.js";

/** Reports one page load may send. */
export const MAX_REPORTS = 5;

export interface ErrorDeps {
  /** `navigator.sendBeacon`, or undefined where the browser has none. */
  sendBeacon?: ((url: string, data: Blob) => boolean) | undefined;
  /** The page's path, read when the failure happens. */
  path: () => string;
}

/** What failed to load: a dynamic import or a lazy chunk, in the words browsers use. */
const CHUNK = /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError|Loading chunk/i;

/** The stack's first frame as `path:line:column`, with the origin (and so the address) cut off. */
export function topFrame(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const m = /(?:https?:\/\/[^/\s]+)?(\/[^\s():?#]+)(?:\?[^\s():]*)?:(\d+):(\d+)/.exec(stack);
  return m ? `${m[1]}:${m[2]}:${m[3]}`.slice(0, 200) : undefined;
}

/** A thrown value of any kind as a message. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function createErrorReporter(deps: ErrorDeps) {
  const sent = new Set<string>();

  /** Build the report for a failure, or null when there is nothing worth sending. */
  function reportFor(kind: "crash" | "error" | "rejection", error: unknown): ClientErrorReport | null {
    // An origin in a message (a failed import names its URL) says which site, never which page: cut it.
    const message = messageOf(error).replace(/\bhttps?:\/\/[^\s/]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!message) return null;
    const where = topFrame(error instanceof Error ? error.stack : undefined);
    return {
      kind: CHUNK.test(message) ? "chunk" : kind,
      message,
      route: matchRoute(deps.path())?.name ?? "none",
      ...(where ? { where } : {}),
    };
  }

  /** Send one report, unless this page load has sent it already or has sent its share. */
  function report(kind: "crash" | "error" | "rejection", error: unknown): boolean {
    const body = reportFor(kind, error);
    if (!body || sent.size >= MAX_REPORTS) return false;
    const key = `${body.kind} ${body.message} ${body.where ?? ""}`;
    if (sent.has(key)) return false;
    sent.add(key);
    try {
      return deps.sendBeacon?.("/api/errors", new Blob([JSON.stringify(body)], { type: "application/json" })) ?? false;
    } catch {
      return false;
    }
  }

  return { report, reportFor, sent: () => sent.size };
}

export const errors = createErrorReporter({
  sendBeacon: typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" ? (url, data) => navigator.sendBeacon(url, data) : undefined,
  path: () => (typeof window === "undefined" ? "/" : window.location.pathname),
});

/** Report what nothing else caught: uncaught errors and unhandled promise rejections. */
export function startErrorReports(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    // A resource that failed to load (an image, a script tag) is an event without an error.
    if (event.error !== undefined || event.message) errors.report("error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => errors.report("rejection", event.reason));
}
