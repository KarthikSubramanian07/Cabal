/**
 * Quoting, wherever press is written: before the start at the lobby's table, and in the game's
 * threads. A dispatch quotes an earlier message by id alone; the server sets the original's own
 * words into it (`PressView.quote`), so a quote can never put words in anybody's mouth.
 */
import { type PowerName, type PressQuote, type PressView, excerpt } from "@cabal/protocol";
import type { CSSProperties } from "react";
import { phaseLabel, powerLabel } from "./terms.js";

/** How much of a message the composer shows while quoting it; the server keeps its own excerpt. */
const QUOTE_PREVIEW = 160;

/** Cut as the server cuts the excerpt itself, by characters as a reader counts them. */
export const quotePreview = (body: string): string => excerpt(body, QUOTE_PREVIEW);

const tint = (power: PowerName) => ({ "--power": `var(--p-${power.toLowerCase()})` }) as CSSProperties;

/** The quoted words set into a dispatch, with whose they are (and when, if from another phase). */
export function QuotedDispatch({ quote, phase }: { quote: PressQuote; phase: string }) {
  return (
    <blockquote className="dispatch-quote" style={tint(quote.from)}>
      <p className="quote-from">
        <span className="sr-only">Quoting </span>
        {powerLabel(quote.from)}
        {quote.phase !== phase ? `, ${quote.phase === "LOBBY" ? "before the game" : phaseLabel(quote.phase)}` : ""}
      </p>
      <p className="quote-text">{quote.excerpt}</p>
    </blockquote>
  );
}

/**
 * The Quote button on a dispatch. Described by the sender rather than named after them: a thread
 * is a live log, and a longer name would be read out with every message that arrives.
 */
export function QuoteButton({ sender, pressed, onToggle }: { sender: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="dispatch-act" aria-pressed={pressed} aria-describedby={sender} onClick={onToggle}>
      Quote
    </button>
  );
}

/** Over the composer while quoting: the start of the message and a way to take the quote off. */
export function QuotingSlip({ id, quoting, me, onUnquote }: { id: string; quoting: PressView; me: PowerName; onUnquote: () => void }) {
  return (
    <div className="quote-slip" id={id} style={tint(quoting.from)}>
      <p className="quote-from">Quoting {quoting.from === me ? "yourself" : powerLabel(quoting.from)}</p>
      <p className="quote-text">{quotePreview(quoting.body)}</p>
      <button type="button" className="dispatch-act" onClick={onUnquote}>
        Remove the quote
      </button>
    </div>
  );
}
