/**
 * The invite link as a QR code, for the friend across the table: point a phone camera at it and
 * the table opens. Loaded on demand (see ShareBar), with the encoder.
 */
import { useMemo } from "react";
import { spacedCode } from "../net/code.js";
import { qrPath } from "./qr.js";

export default function InviteQr({ link, code }: { link: string; code: string }) {
  const qr = useMemo(() => qrPath(link), [link]);
  return (
    <figure className="invite-qr">
      <svg
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label={`QR code that opens table ${spacedCode(code)}`}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} className="qr-paper" />
        <path d={qr.d} className="qr-ink" />
      </svg>
      <figcaption>
        <span className="qr-code">{spacedCode(code)}</span>
        <span className="qr-hint">Point a phone camera here to open the table.</span>
      </figcaption>
    </figure>
  );
}
