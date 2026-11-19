/** A full-page notice in the house style: a stamp, a headline, a line or two, and ways on. */
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "./router.jsx";

export interface StatusPageProps {
  /** Rubber-stamp text, e.g. `Not yet`. */
  stamp: string;
  /** Small line above the title, e.g. `Game K7Q2`. */
  eyebrow?: string | undefined;
  title: string;
  /** Sets `document.title`. */
  pageTitle: string;
  /** `alert` draws the stamp in vermilion: something is wrong, rather than merely pending. */
  tone?: "pending" | "alert";
  children: ReactNode;
  actions?: ReactNode;
}

export function StatusPage({ stamp, eyebrow, title, pageTitle, tone = "pending", children, actions }: StatusPageProps) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const before = document.title;
    document.title = `${pageTitle} — Cabal`;
    // A notice is not a page for a search index.
    let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const added = !robots;
    if (!robots) {
      robots = document.createElement("meta");
      robots.name = "robots";
      document.head.append(robots);
    }
    const previous = robots.content;
    robots.content = "noindex, follow";
    heading.current?.focus();
    return () => {
      document.title = before;
      if (added) robots.remove();
      else robots.content = previous;
    };
  }, [pageTitle]);

  return (
    <main className="status-page" id="main" tabIndex={-1}>
      <div className="status-card">
        <p className={`stamp ${tone}`} aria-hidden="true">
          {stamp}
        </p>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <div className="status-body">{children}</div>
        <div className="status-actions">
          {actions ?? (
            <>
              <Link className="btn brass" href="/sandbox">
                Open the sandbox
              </Link>
              <a className="btn" href="/about">
                About Cabal
              </a>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
