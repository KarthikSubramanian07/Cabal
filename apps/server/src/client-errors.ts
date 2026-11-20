/**
 * `POST /api/errors`: a page that broke tells the server (issue #12, observability). Each report is
 * one `client_error` log line in Workers Logs, beside the server's own `unhandled_error` lines, so
 * an operator filtering on `level: "error"` sees what players met as well as what the server threw.
 * No third-party error service, and nothing stored: the line carries the report, the continent the
 * request came from and the build that served it, never an address, a player or a device.
 *
 * Reports share the beacons' rules: from this deployment's own pages only, and `METRICS_LIMITER`'s
 * six a minute per address, counted apart from the timings.
 */
import { ClientErrorReport } from "@cabal/protocol";
import type { Env } from "./env.js";
import { json, limited, readJson, tooMany, withCors } from "./http.js";
import { log } from "./log.js";
import { beaconOriginAllowed, continentOf } from "./metrics.js";

/** The powers whose names are six capitals too, and so look like a game code. */
const SIX_LETTER_POWERS = new Set(["FRANCE", "RUSSIA", "TURKEY"]);

/**
 * A message as it is logged: one line, with anything that looks like a URL cut to its path's first
 * segment, long runs of letters and digits (a token, an id) masked, and game codes masked: a code is
 * a table's address, and the privacy page promises a report never says which table broke. Messages
 * come from code, but an exception can quote what it was handed.
 */
export function scrubMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/\bhttps?:\/\/[^\s/]+(\/[^\s/?#]*)?[^\s]*/g, (_, first: string | undefined) => `<url>${first ?? ""}`)
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\b[A-HJ-NP-Za-hj-np-z2-9]{6}\b/g, (word) => (/[2-9]/.test(word) || (word === word.toUpperCase() && !SIX_LETTER_POWERS.has(word)) ? "<code>" : word))
    .trim()
    .slice(0, 300);
}

export async function clientErrorsRoute(request: Request, env: Env, url: URL, build: string): Promise<Response | null> {
  if (url.pathname !== "/api/errors") return null;
  if (request.method !== "POST") return withCors(json({ error: "not found" }, 404));
  if (!beaconOriginAllowed(request, url)) return withCors(json({ error: "reports come from this deployment's own pages" }, 403));
  if (await limited(env.METRICS_LIMITER, request, "errors")) return tooMany();
  const body = ClientErrorReport.safeParse(await readJson(request));
  if (!body.success) return withCors(json({ error: "invalid request", issues: body.error.issues }, 400));
  const report = body.data;
  log(
    "client_error",
    {
      kind: report.kind,
      message: scrubMessage(report.message),
      page: report.route,
      ...(report.where ? { where: scrubMessage(report.where).slice(0, 200) } : {}),
      continent: continentOf(request),
      build,
    },
    "error",
  );
  return withCors(new Response(null, { status: 204 }));
}
