/**
 * A pledge, as it hangs from a dispatch. Sealed: a wax seal pressed with the commitment, the
 * orders unseen. Open: the orders written out. Once the phase resolves: the receipt is stamped
 * across it (KEPT, BROKEN or VOID) and the seal is opened again on this device, with the result
 * said in words.
 */
import type { OrderResultView, PledgeView } from "@cabal/protocol";
import { useMemo } from "react";
import { phaseLabel, powerLabel } from "../lobby/terms.js";
import { checkReceipt, checkSeal, shortCommitment } from "./seals.js";

const STAMP: Record<string, string> = { kept: "Kept", broken: "Broken", void: "Void" };

/** The wax: a scalloped disc pressed with a turned A, the cabal's mark. Drawn, so it scales. */
export function Wax({ broken = false }: { broken?: boolean }) {
  const teeth = 18;
  const points: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (Math.PI * i) / teeth;
    const r = i % 2 === 0 ? 30 : 27.4;
    points.push(`${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`);
  }
  return (
    <svg className={`wax${broken ? " broken" : ""}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <polygon className="wax-body" points={points.join(" ")} />
      <circle className="wax-ring" cx="32" cy="32" r="20" />
      {/* The turned A of the wordmark: the member of the cabal who is not what they seem. */}
      <path className="wax-mark" d="M23 22h18L32 44z M27.6 26 32 36.4 36.4 26z" fillRule="evenodd" />
      {broken ? <path className="wax-crack" d="M30 2 35 18 28 30 37 44 31 62" /> : null}
    </svg>
  );
}

export function SealCard({ pledge, results, mine }: { pledge: PledgeView; results: readonly OrderResultView[] | null; mine: boolean }) {
  const seal = useMemo(() => checkSeal(pledge), [pledge]);
  const receipt = useMemo(() => checkReceipt(pledge, results), [pledge, results]);
  const hidden = pledge.orders === null;
  const to = pledge.audience === "ALL" ? "the table" : powerLabel(pledge.audience);
  const stamp = pledge.receipt;
  return (
    <figure className={`seal-card${pledge.sealed ? " sealed" : " open"}${stamp ? ` stamped ${stamp}` : ""}`} aria-label={`Seal from ${powerLabel(pledge.pledger)}`}>
      <div className="seal-head">
        {pledge.sealed ? <Wax broken={stamp === "broken"} /> : null}
        <figcaption>
          <span className="seal-kind">{pledge.sealed ? "Sealed pledge" : "Open pledge"}</span>
          <span className="seal-sub">
            {powerLabel(pledge.pledger)} to {to}, {phaseLabel(pledge.phase)}
          </span>
          <code className="seal-hash" title={pledge.commitment}>
            {shortCommitment(pledge.commitment)}
          </code>
        </figcaption>
        {stamp ? (
          <span className={`rubber ${stamp}`} role="img" aria-label={`Receipt: ${STAMP[stamp]}`}>
            {STAMP[stamp]}
          </span>
        ) : null}
      </div>
      {hidden ? (
        <p className="seal-note">The orders stay under the seal until the phase resolves.</p>
      ) : (
        <ol className="seal-orders">
          {pledge.orders!.map((o) => (
            <li key={o}>
              <code>{o}</code>
            </li>
          ))}
        </ol>
      )}
      {pledge.sealed && !stamp && mine ? <p className="seal-note">Only you can read these until the phase resolves. The nonce that opens the seal is kept on this device.</p> : null}
      {stamp ? (
        <div className="seal-proof">
          {seal === "opens" ? (
            <p className="proof ok">
              <span aria-hidden="true">✓</span> Opened on this device: the revealed orders and nonce make exactly this seal.
            </p>
          ) : seal === "fails" ? (
            <p className="proof bad" role="alert">
              <span aria-hidden="true">✕</span> This seal does not open with the orders revealed. What was shown is not what was sealed.
            </p>
          ) : null}
          {receipt === "agrees" ? (
            <p className="proof ok">
              <span aria-hidden="true">✓</span> The receipt agrees with the adjudication this device received.
            </p>
          ) : receipt === "disagrees" ? (
            <p className="proof bad" role="alert">
              <span aria-hidden="true">✕</span> The receipt does not match the adjudication this device received.
            </p>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}
