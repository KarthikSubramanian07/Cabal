/**
 * Ways to bring people to a table: copy the link, hand it to the system share sheet where there is
 * one, or show it as a QR code for somebody in the same room. The link carries only the code, so
 * it is safe to share anywhere.
 */
import { Suspense, lazy, useId, useState } from "react";
import { spacedCode } from "../net/code.js";

const InviteQr = lazy(() => import("./InviteQr.jsx"));

export function ShareBar({ code }: { code: string }) {
  const [said, setSaid] = useState("");
  const [qr, setQr] = useState(false);
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
          <Suspense fallback={<div className="invite-qr loading" aria-hidden="true" />}>
            <InviteQr link={link} code={code} />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
