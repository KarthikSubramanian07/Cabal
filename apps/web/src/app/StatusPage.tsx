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
    // These pages have nothing for a search index yet.
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.append(robots);
    heading.current?.focus();
    return () => {
      document.title = before;
      robots.remove();
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
