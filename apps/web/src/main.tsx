import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./app/App.jsx";
import { listenForInstall } from "./pwa/InstallButton.jsx";
import { registerServiceWorker } from "./pwa/register.js";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const mount = root;

// The offline copy and the update prompt (production builds only), and the install prompt,
// which the browser may offer before React has drawn anything.
registerServiceWorker();
listenForInstall();

function start(): void {
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  );
  // The front door arrives already drawn (src/landing/prerender.tsx): take it over in place, so
  // its one moment of motion is not started twice. Any other page draws from the loading screen.
  if (mount.dataset["prerendered"] === "home" && window.location.pathname === "/") hydrateRoot(mount, app);
  else createRoot(mount).render(app);
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
