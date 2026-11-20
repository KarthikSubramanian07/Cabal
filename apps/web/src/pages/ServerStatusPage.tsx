/**
 * `/status`: is Cabal's server answering, and which build is it? Read live from the server's own
 * health check (`GET /api/health`), every 30 seconds while the page is open and on request: the
 * deployed build, the engine, the games index and its schema, how long the answer took, and
 * whether this page speaks the server's protocol. No third-party status service.
 */
import { type HealthResponse, PROTOCOL_VERSION } from "@cabal/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadApi } from "../net/lazy.js";

const EVERY_MS = 30_000;

type Check = { kind: "checking" } | { kind: "answered"; health: HealthResponse; ms: number; at: number } | { kind: "silent"; reason: string; at: number };

/** A build `pnpm deploy:server` stamped: a commit hash, `-dirty` when the tree had uncommitted changes. */
const COMMIT = /^([0-9a-f]{7,40})(-dirty)?$/;

/** The commit a build names, on GitHub, or null for a build that is not one (`dev`, a version id). */
export function commitUrl(build: string): string | null {
  const m = COMMIT.exec(build);
  return m && !m[2] ? `https://github.com/KarthikSubramanian07/Cabal/commit/${m[1]}` : null;
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function ServerStatusPage() {
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const run = useCallback(async () => {
    setBusy(true);
    const started = performance.now();
    try {
      const { api } = await loadApi();
      const health = await api.health();
      setCheck({ kind: "answered", health, ms: Math.round(performance.now() - started), at: Date.now() });
    } catch (error) {
      // A 503 still carries the report; anything else is silence.
      const body = (error as { body?: unknown }).body as HealthResponse | undefined;
      if (body && typeof body === "object" && "build" in body) setCheck({ kind: "answered", health: body, ms: Math.round(performance.now() - started), at: Date.now() });
      else setCheck({ kind: "silent", reason: error instanceof Error ? error.message : String(error), at: Date.now() });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    heading.current?.focus();
    void run();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [run]);

  const health = check.kind === "answered" ? check.health : null;
  const state = check.kind === "checking" ? "checking" : check.kind === "silent" ? "silent" : health!.ok ? "ok" : "trouble";
  const stamp = { checking: "Asking", ok: "In service", trouble: "Trouble", silent: "No answer" }[state];
  const title = {
    checking: "Asking the server.",
    ok: "Cabal is running.",
    trouble: "The server answers, but not well.",
    silent: "The server is not answering.",
  }[state];
  const index = health?.index;

  return (
    <main className="status-page server-status" id="main" tabIndex={-1}>
      <div className="status-card">
        <p className={`stamp ${state === "trouble" || state === "silent" ? "alert" : "pending"}`} aria-hidden="true">
          {stamp}
        </p>
        <p className="eyebrow">Status</p>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <div className="status-body" aria-live="polite">
          {state === "silent" ? (
            <p>Games already in progress keep their state on the server and pick up where they were when it answers again.</p>
          ) : null}
          {state === "trouble" ? <p>The games index is not answering as this build needs, so new games, records and the Ledger may fail until it does.</p> : null}
          {health ? (
            <dl className="status-facts">
              <div>
                <dt>Build</dt>
                <dd>
                  {commitUrl(health.build) ? (
                    <a href={commitUrl(health.build)!}>
                      <code>{health.build}</code>
                    </a>
                  ) : (
                    <code>{health.build}</code>
                  )}
                </dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>{health.engine}</dd>
              </div>
              <div>
                <dt>Games index</dt>
                <dd>
                  {index!.reachable ? "Answering" : "Not answering"}
                  {index!.schema !== null ? `, schema ${index!.schema}` : ""} ({index!.backend === "d1" ? "D1" : index!.backend})
                </dd>
              </div>
              <div>
                <dt>Protocol</dt>
                <dd>
                  {health.protocol === PROTOCOL_VERSION ? `Version ${health.protocol}, the same as this page` : `Server ${health.protocol}, this page ${PROTOCOL_VERSION}: reload the page`}
                </dd>
              </div>
              <div>
                <dt>Answer time</dt>
                <dd>{(check as { ms: number }).ms} ms from this device</dd>
              </div>
            </dl>
          ) : null}
          {check.kind !== "checking" ? (
            <p className="status-checked">
              Checked at {time(check.at)}; again every 30 seconds while this page is open.
              {check.kind === "silent" ? ` What came back: ${check.reason}.` : ""}
            </p>
          ) : null}
        </div>
        <div className="status-actions">
          <button type="button" className="btn brass" onClick={() => void run()} disabled={busy}>
            {busy ? "Asking" : "Check again"}
          </button>
          <a className="btn" href="https://github.com/KarthikSubramanian07/Cabal/issues">
            Report a problem
          </a>
        </div>
      </div>
    </main>
  );
}
