/**
 * Reporting a player to the maintainers, at the foot of their record: one quiet line until it is
 * asked for, then a short form in place (why, and what happened), then a receipt. Only a signed-in
 * player looking at someone else's record sees it. The player reported is never told who sent it.
 */
import type { ReportReason } from "@cabal/protocol";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { loadApi } from "../net/lazy.js";
import { readPlayer } from "../net/player.js";
import { failureText } from "../net/failure.js";

const REASONS: { value: ReportReason; label: string; blurb: string }[] = [
  { value: "cheating", label: "Cheating", blurb: "Breaking the rules of the site, not of the game: lies and betrayals are play." },
  { value: "abuse", label: "Abuse", blurb: "Threats, slurs or harassment in press or in a handle." },
  { value: "multi_account", label: "More than one account", blurb: "One person holding several seats at a table." },
  { value: "other", label: "Something else", blurb: "Say what in the note." },
];

const NOTE_MAX = 500;

type State = { kind: "closed" } | { kind: "open" } | { kind: "sending" } | { kind: "sent" };

export function ReportPlayer({ handle }: { handle: string }) {
  const [state, setState] = useState<State>({ kind: "closed" });
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (state.kind === "open") first.current?.focus();
    if (state.kind === "sent") receipt.current?.focus();
  }, [state.kind]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason) {
      setError("Choose what the report is about.");
      return;
    }
    const me = readPlayer();
    if (!me) {
      setError("Sign in again to send a report.");
      return;
    }
    setState({ kind: "sending" });
    setError(null);
    try {
      const { api } = await loadApi();
      const trimmed = note.trim();
      await api.reportPlayer(me.secret, handle, { reason, ...(trimmed ? { note: trimmed } : {}) });
      setState({ kind: "sent" });
    } catch (err) {
      setError(failureText(err));
      setState({ kind: "open" });
    }
  }

  function cancel() {
    setState({ kind: "closed" });
    setReason(null);
    setNote("");
    setError(null);
    requestAnimationFrame(() => opener.current?.focus());
  }

  return (
    <section className="file-report" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="sr-only">
        Report {handle}
      </h2>
      {state.kind === "closed" ? (
        <p className="file-report-line">
          Something wrong with how {handle} plays?{" "}
          <button ref={opener} type="button" className="link-button" onClick={() => setState({ kind: "open" })}>
            Report {handle} to the maintainers
          </button>
        </p>
      ) : state.kind === "sent" ? (
        <p className="file-report-receipt" ref={receipt} tabIndex={-1} role="status">
          <strong>Report received.</strong> A maintainer reads every one. {handle} is not told who sent it, and nothing on their record changes until someone has looked.
        </p>
      ) : (
        <form className="file-report-form" onSubmit={submit} noValidate>
          <p className="file-report-lede">
            Tell the maintainers about <strong>{handle}</strong>. Only they read it.
          </p>
          <fieldset className="options" disabled={state.kind === "sending"} aria-describedby={error ? `${id}-error` : undefined}>
            <legend>What is it about?</legend>
            <div className="options-list">
              {REASONS.map((r, i) => (
                <label key={r.value} className="option">
                  <input ref={i === 0 ? first : undefined} type="radio" name={`${id}-reason`} value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
                  <span className="option-label">{r.label}</span>
                  <span className="option-blurb">{r.blurb}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor={`${id}-note`}>What happened (optional)</label>
            <textarea
              id={`${id}-note`}
              rows={3}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={state.kind === "sending"}
              aria-describedby={`${id}-count`}
            />
            <span className="field-note" id={`${id}-count`}>
              {NOTE_MAX - note.length} characters left. Name the table if it happened at one.
            </span>
          </div>
          {error ? (
            <p className="form-error" id={`${id}-error`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="seal-actions">
            <button type="submit" className="btn brass" disabled={state.kind === "sending"}>
              {state.kind === "sending" ? "Sending" : "Send the report"}
            </button>
            <button type="button" className="btn" onClick={cancel} disabled={state.kind === "sending"}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
