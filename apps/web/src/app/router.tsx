/**
 * A small history router. No dependency: the app has a handful of flat routes, and the
 * table in routes.ts is also what the edge worker reads. Links to anything outside the
 * table (the static trust pages, files, other sites) are ordinary navigations.
 */
import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";
import { type RouteMatch, matchRoute } from "./routes.js";

const CHANGE = "cabal:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

const pathname = () => window.location.pathname;

/** The current pathname, re-rendering on navigation. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, pathname, () => "/");
}

/** The route the current path matches, or null when the client has no page for it. */
export function useRoute(): RouteMatch | null {
  return matchRoute(usePathname());
}

/** Go to an in-app path without reloading. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.href);
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  if (options.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** An anchor that navigates in place when its target is an app route. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !isPlainLeftClick(e) || rest.target) return;
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin || !matchRoute(url.pathname)) return;
        e.preventDefault();
        navigate(url.pathname + url.search);
      }}
    />
  );
}
