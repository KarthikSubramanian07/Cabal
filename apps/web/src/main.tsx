import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.jsx";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const mount = root;

function start(): void {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// #root arrives holding the loading screen and the page's own text, written in by the build
// (scripts/emit-agent-site.mjs). When this script is already in the cache it would run before
// the browser has drawn anything, and the first paint would wait for React. Give the browser
// one frame to draw what it has, then take over; what React draws first is the same screen.
// Frames are not promised (a background tab, a throttled embed), so a timer starts it anyway.
let started = false;
function startOnce(): void {
  if (started) return;
  started = true;
  start();
}
requestAnimationFrame(() => setTimeout(startOnce, 0));
setTimeout(startOnce, 150);
