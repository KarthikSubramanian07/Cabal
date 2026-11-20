/**
 * The shell's fetch hints are written for the pages that want them (vite.config.ts tags each one
 * with `data-for="sandbox game replay"`). One copy of the shell serves every app route, so the
 * Pages worker keeps the hints for the page it is serving and drops the others: on a phone, a
 * chunk or an engine the page never uses competes with the page's own script and data.
 */
const TAGGED = /\s*<link\b[^>]*\sdata-for="([^"]*)"[^>]*>/g;

/** The shell with only the hints for `route` (a route name, or null for a page with none). */
export function hintsFor(html: string, route: string | null): string {
  return html.replace(TAGGED, (tag, routes: string) => (route !== null && routes.split(/\s+/).includes(route) ? tag : ""));
}
