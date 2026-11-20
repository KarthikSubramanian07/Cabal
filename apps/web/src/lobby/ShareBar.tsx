/**
 * Ways to bring people to a table: copy the link, hand it to the system share sheet where there is
 * one, or show it as a QR code for somebody in the same room. The link carries only the code, so
 * it is safe to share anywhere.
 */
import { Component, type ReactNode, Suspense, lazy, useId, useState } from "react";
import { spacedCode } from "../net/code.js";

/** The QR card's code, fetched the first time it is shown. A fresh one for every try. */
const loadQr = () => lazy(() => import("./InviteQr.jsx"));

/**
 * The QR card's own boundary: if its code cannot be fetched (a flaky connection, or a redeploy
 * that took the old file away), the card says so and the lobby carries on, the link still a tap
 * away. Without it the failure reached the page's boundary and the whole lobby was lost.
 */
class QrBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function ShareBar({ code }: { code: string }) {
  const [said, setSaid] = useState("");
  const [qr, setQr] = useState(false);
  const [InviteQr, setInviteQr] = useState(loadQr);
  const [tries, setTries] = useState(0);
  const qrId = useId();
  const link = `${window.location.origin}/g/${code}`;
  const canShare = typeof navigator.share === "function";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setSaid("Link copied. Send it to the people you want at the table.");
    } catch {
      setSaid(`Copy this link: ${link}`);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: `Cabal table ${spacedCode(code)}`, text: `Take a seat at my Diplomacy table. Code ${spacedCode(code)}.`, url: link });
    } catch {
      // Dismissed: nothing to say.
    }
  }

  // Two grid items in the table's header: the buttons beside the code, the card under them.
  return (
    <>
      <div className="share">
        <button type="button" className="btn" onClick={copy}>
          Copy link
        </button>
        {canShare ? (
          <button type="button" className="btn" onClick={share}>
            Share
          </button>
        ) : null}
        <button type="button" className="btn" aria-expanded={qr} aria-controls={qrId} onClick={() => setQr((o) => !o)}>
          {qr ? "Hide the QR code" : "QR code"}
        </button>
        <span className="share-said" role="status">
          {said}
        </span>
      </div>
      <div className="share-qr" id={qrId} hidden={!qr}>
        {qr ? (
          <QrBoundary
            key={tries}
            fallback={
              <div className="invite-qr failed" role="status">
                <p>The QR code would not load. Copy the link instead, or try again.</p>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setInviteQr(loadQr);
                    setTries((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            }
          >
            <Suspense fallback={<div className="invite-qr loading" aria-hidden="true" />}>
              <InviteQr link={link} code={code} />
            </Suspense>
          </QrBoundary>
        ) : null}
      </div>
    </>
  );
}
