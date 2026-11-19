/**
 * The front door drawn to HTML at build time (scripts/emit-agent-site.mjs writes it into
 * dist/landing/index.html). It is the app itself at `/`, so the browser hydrates exactly this
 * markup: the headline is on screen before any script has run, and nothing redraws when it does.
 */
import { renderToString } from "react-dom/server";
import { App } from "../app/App.jsx";

export function renderLanding(): string {
  return renderToString(<App />);
}
