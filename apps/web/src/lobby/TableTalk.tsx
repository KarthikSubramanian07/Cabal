/**
 * Table talk: the public thread, as dispatches. Before the game starts it is the lobby's chat
 * (the server files it under phase `LOBBY` and allows only messages to the whole table); once the
 * game runs it is the public press. Seated players write; spectators read.
 *
 * The thread is a log region, so screen readers hear new dispatches as they arrive.
 */
import type { PowerName, PressView } from "@cabal/protocol";
import { CabalError } from "@cabal/protocol/client";
import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { powerLabel } from "./terms.js";

const ERRORS: Record<string, string> = {
  no_press: "This is a gunboat game: no messages at all.",
  press_limit: "You have sent as many messages as this phase allows.",
  rate_limited: "That is a lot of messages at once. Wait a moment.",
  press_rate_limited: "That is a lot of messages at once. Wait a minute and send it again.",
  press_closed: "Press is closed during retreats and adjustments in this game.",
};

function when(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TableTalk({
  press,
  names,
  me,
  canWrite,
  readOnlyNote,
  onSay,
}: {
  press: PressView[];
  /** Display names by power, for the dateline. */
  names: Partial<Record<PowerName, string | null>>;
  me: PowerName | null;
  canWrite: boolean;
  /** What a reader who cannot write is told instead of the composer. */
  readOnlyNote: string;
  onSay: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const errorId = useId();
  const visible = press.filter((m) => m.to === "ALL");

  // Keep the newest dispatch in view as they arrive.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSay(text);
      setBody("");
    } catch (err) {
      setError(err instanceof CabalError ? (ERRORS[err.code] ?? err.message) : "The message did not go through. Check your connection and send it again.");
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift and Enter starts a new line, as in every chat.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <section className="talk" aria-labelledby={titleId}>
      <h2 id={titleId}>Table talk</h2>
      {/* The log is the scrolling region; the list inside keeps its list semantics. */}
      <div className="talk-log" ref={list} role="log" aria-labelledby={titleId} tabIndex={0}>
        <ol>
        {visible.length === 0 ? (
          <li className="talk-empty">Nothing said yet. Everything here is read by the whole table.</li>
        ) : (
          visible.map((m) => (
            <li key={m.id} className={`dispatch${m.from === me ? " mine" : ""}`} style={{ "--power": `var(--p-${m.from.toLowerCase()})` } as CSSProperties}>
              <p className="dateline">
                <span className="dispatch-from">{powerLabel(m.from)}</span>
                {names[m.from] ? <span className="dispatch-name">{names[m.from]}</span> : null}
                <time dateTime={new Date(m.sentAt).toISOString()}>{when(m.sentAt)}</time>
              </p>
              <p className="dispatch-body">{m.body}</p>
            </li>
          ))
        )}
        </ol>
      </div>
      {canWrite ? (
        <form className="talk-compose" onSubmit={submit}>
          <label htmlFor="talk-body">Message the table</label>
          <textarea
            ref={area}
            id="talk-body"
            rows={2}
            maxLength={4000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKey}
            aria-describedby={error ? errorId : undefined}
          />
          <div className="talk-row">
            <span className="fine">Enter sends. Shift and Enter for a new line.</span>
            <button type="submit" className="btn" disabled={busy || body.trim() === ""}>
              Send
            </button>
          </div>
          {error ? (
            <p className="form-error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="talk-note">{readOnlyNote}</p>
      )}
    </section>
  );
}
