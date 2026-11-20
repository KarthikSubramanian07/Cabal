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
//
// Where the browser reports largest paints, wait for the first one too. It is reported a frame
// or so after the paint, and a loading card React replaced in between was never counted: the
// browser took React's copy, drawn later, as the page's largest paint instead.
let started = false;
function startOnce(): void {
  if (started) return;
  started = true;
  start();
}

// Fetch hints that can wait (a table's room and map, at low priority) are written into the shell
// inert (vite.config.ts) and switched on with the takeover, so on a slow line the first paint
// has the line to itself. What the page imports does not wait for them: they only start early.
function hintTheRest(): void {
  const later = document.getElementById("after-paint");
  if (later instanceof HTMLTemplateElement) document.head.append(later.content.cloneNode(true));
}

function afterFirstPaint(go: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    go();
  };
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("largest-contentful-paint")) {
    const observer = new PerformanceObserver(() => {
      observer.disconnect();
      setTimeout(once, 0);
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
    // A page whose first frame holds no text or image reports none: go a little after it anyway.
    requestAnimationFrame(() => setTimeout(once, 250));
  } else {
    requestAnimationFrame(() => setTimeout(once, 0));
  }
  setTimeout(once, 1000);
}

afterFirstPaint(() => {
  startOnce();
  hintTheRest();
});
