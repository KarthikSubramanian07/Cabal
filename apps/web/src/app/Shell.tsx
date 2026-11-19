/**
 * The frame every screen shares: skip link, ink top bar with the wordmark, footer and the
 * How to play dialog. The static trust pages (scripts/emit-agent-site.mjs) render the same
 * header markup so the brand does not break one click from the board.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Wordmark } from "../brand/Wordmark.jsx";
import { HowToPlay } from "./HowToPlay.jsx";
import { useShortcuts } from "./prefs.js";
import { Link, usePathname } from "./router.jsx";
import { matchRoute } from "./routes.js";

export const SOURCE_URL = "https://github.com/KarthikSubramanian07/Cabal";

export function Shell({ children }: { children: ReactNode }) {
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const [shortcuts, setShortcuts] = useShortcuts();
  const path = usePathname();
  const route = matchRoute(path);
  const header = useRef<HTMLElement>(null);

  // The phone menu closes when the route changes, on Escape and on a tap outside it.
  useEffect(() => setMenu(false), [path]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!header.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menu]);

  return (
    <div className="app" data-route={route?.name ?? "missing"}>
      <a className="skip-link" href="#main">
        Skip to the {route?.name === "sandbox" ? "board" : "page"}
      </a>
      <header className="topbar" ref={header}>
        <Link className="brand" href="/" aria-label="Cabal home">
          <Wordmark height={22} color="var(--bone)" />
        </Link>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={menu}
          aria-controls="site-nav"
          onClick={() => setMenu((open) => !open)}
        >
          Menu
        </button>
        <nav id="site-nav" aria-label="Site" data-open={menu}>
          <Link href="/sandbox" aria-current={route?.name === "sandbox" ? "page" : undefined}>
            Sandbox
          </Link>
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setHelp(true);
            }}
          >
            How to play
          </button>
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
          <a className="nav-end" href={SOURCE_URL}>
            GitHub
          </a>
        </nav>
      </header>

      {children}

      <footer className="footer">
        {route?.name === "sandbox" ? <span>Sandbox: every power is yours to order.</span> : <span>Diplomacy with receipts.</span>}
        <span>Adjudicated in your browser by a Rust engine that passes all 171 DATC cases.</span>
        <span>Board drawn from Natural Earth.</span>
        <span className="footer-links">
          <a href="/about">About</a>
          <a href="/contact">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/llms.txt">llms.txt</a>
          <a href={SOURCE_URL}>Source</a>
        </span>
      </footer>

      <HowToPlay open={help} onClose={() => setHelp(false)} shortcuts={shortcuts} onShortcuts={setShortcuts} />
    </div>
  );
}
