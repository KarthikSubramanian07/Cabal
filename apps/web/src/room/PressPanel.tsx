/**
 * Press in a live game: the table and one private thread per power, as dispatches. A seated player
 * writes, and may attach a Seal: a pledge over some of their own orders this phase, sealed on this
 * device (see seals.ts) or left open for the reader to see at once.
 */
import type { GameSettings, GameStatus, OrderResultView, PledgeInput, PowerName, PressView, Recipient } from "@cabal/protocol";
import { CabalError } from "@cabal/protocol/client";
import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { QuoteButton, QuotedDispatch, QuotingSlip } from "../lobby/Quote.jsx";
import { phaseLabel, powerLabel } from "../lobby/terms.js";
import { SealCard } from "./SealCard.jsx";
import { makeSeal } from "./seals.js";
import { type Thread, pressOpen, threadLabel, whispersLeft } from "./threads.js";

const ERRORS: Record<string, string> = {
  no_press: "This is a gunboat game: no messages at all.",
  public_only: "Public press: everything is said to the whole table.",
  lobby_public_only: "Before the game starts, everything is said to the whole table.",
  press_limit: "You have sent as many messages as this phase allows.",
  whisper_budget: "You have used this phase's private messages. The table is still open.",
  rate_limited: "That is a lot of messages at once. Wait a moment.",
  press_rate_limited: "That is a lot of messages at once. Wait a minute and send it again.",
  press_closed: "Press is closed during retreats and adjustments in this game.",
  not_active: "The game is not running, so nothing can be sent.",
  spectator: "Only players at this table can write.",
  bad_quote: "Only a message from this thread can be quoted here.",
};

function when(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export interface PressPanelProps {
  threads: Thread[];
  me: PowerName | null;
  names: Partial<Record<PowerName, string | null>>;
  settings: GameSettings;
  status: GameStatus;
  phase: string;
  press: readonly PressView[];
  /** The panel is on screen, so opening a thread reads it. */
  visible: boolean;
  /** The seat's current orders, to pledge from. */
  myOrders: string[];
  /** The adjudicated orders of a resolved phase, to check receipts against. */
  resultsFor: (phase: string) => readonly OrderResultView[] | null;
  /** The engine is loaded here, so seals can be made and opened. */
  engineReady: boolean;
  connected: boolean;
  onSend: (to: Recipient, body: string, pledge?: PledgeInput, quote?: string) => Promise<void>;
  onRead: (thread: Recipient, upTo: number) => void;
  /** The open thread, when the room keeps it (a dispatch slip can open one); the panel's own otherwise. */
  thread?: Recipient;
  onThread?: (thread: Recipient) => void;
}

export function PressPanel(props: PressPanelProps) {
  const { threads, me, names, settings, status, phase, press, visible, myOrders, resultsFor, engineReady, connected, onSend, onRead } = props;
  const [own, setOwn] = useState<Recipient>("ALL");
  const open = props.thread ?? own;
  const setOpen = props.onThread ?? setOwn;
  const thread = threads.find((t) => t.id === open) ?? threads[0]!;
  const log = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const fromId = useId();
  /** The message the composer is quoting; a quote never follows the player to another thread. */
  const [quoting, setQuoting] = useState<PressView | null>(null);
  useEffect(() => setQuoting(null), [thread.id]);
  const canQuote = me !== null && pressOpen(settings, status, phase, thread.id).open;

  // Reading a thread on screen marks it read, here and on the server.
  useEffect(() => {
    if (visible && thread.unread > 0 && thread.last > 0) onRead(thread.id, thread.last);
  }, [visible, thread.id, thread.unread, thread.last, onRead]);

  // Keep the newest dispatch in view.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.id, thread.messages.length, visible]);

  return (
    <section className="press" aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        Press
      </h2>
      {threads.length > 1 ? (
        <div className="threads" role="group" aria-label="Threads">
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === thread.id}
              className="thread-tab"
              style={{ "--power": t.id === "ALL" ? "var(--ink)" : `var(--p-${t.id.toLowerCase()})` } as CSSProperties}
              onClick={() => setOpen(t.id)}
            >
              {threadLabel(t.id)}
              {t.unread > 0 ? (
                <>
                  <span className="sr-only">, {t.unread} unread</span>
                  <span className="unread" aria-hidden="true">
                    {t.unread}
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="thread-log"
        id="thread-log"
        ref={log}
        role="log"
        aria-label={thread.id === "ALL" ? "The table: everything here is read by every player" : `Private thread with ${threadLabel(thread.id)}`}
        tabIndex={0}
      >
        <p className="thread-head">
          {thread.id === "ALL" ? (
            <>
              <strong>The table.</strong> Read by every player and every spectator.
            </>
          ) : (
            <>
              <strong>{powerLabel(thread.id)}</strong>
              {names[thread.id as PowerName] ? `, ${names[thread.id as PowerName]}` : ""}. Only the two of you read this.
            </>
          )}
        </p>
        <ol>
          {thread.messages.length === 0 ? (
            <li className="talk-empty">{thread.id === "ALL" ? "Nothing said at the table yet." : "No dispatches yet. Open with an offer."}</li>
          ) : (
            thread.messages.map((m, i) => {
              const prev = thread.messages[i - 1];
              const turn = !prev || prev.phase !== m.phase;
              return (
                <li key={m.id} className={`dispatch${m.from === me ? " mine" : ""}`} style={{ "--power": `var(--p-${m.from.toLowerCase()})` } as CSSProperties}>
                  {turn ? <p className="phase-rule">{m.phase === "LOBBY" ? "Before the game" : phaseLabel(m.phase)}</p> : null}
                  <p className="dateline">
                    <span className="dispatch-from" id={`${fromId}-${m.id}`}>
                      {powerLabel(m.from)}
                    </span>
                    {names[m.from] ? <span className="dispatch-name">{names[m.from]}</span> : null}
                    <time dateTime={new Date(m.sentAt).toISOString()}>{when(m.sentAt)}</time>
                    {canQuote ? <QuoteButton sender={`${fromId}-${m.id}`} pressed={quoting?.id === m.id} onToggle={() => setQuoting(quoting?.id === m.id ? null : m)} /> : null}
                  </p>
                  {m.quote ? <QuotedDispatch quote={m.quote} phase={m.phase} /> : null}
                  <p className="dispatch-body">{m.body}</p>
                  {m.pledge ? <SealCard pledge={m.pledge} results={resultsFor(m.pledge.phase)} mine={m.from === me} /> : null}
                </li>
              );
            })
          )}
        </ol>
      </div>
      {me ? (
        <Composer
          key={thread.id}
          to={thread.id}
          me={me}
          settings={settings}
          status={status}
          phase={phase}
          press={press}
          myOrders={myOrders}
          engineReady={engineReady}
          connected={connected}
          quoting={quoting}
          onUnquote={() => setQuoting(null)}
          onSend={onSend}
        />
      ) : (
        <p className="talk-note">You are watching. Only the players at this table write here.</p>
      )}
    </section>
  );
}

function Composer({
  to,
  me,
  settings,
  status,
  phase,
  press,
  myOrders,
  engineReady,
  connected,
  quoting,
  onUnquote,
  onSend,
}: {
  to: Recipient;
  me: PowerName;
  settings: GameSettings;
  status: GameStatus;
  phase: string;
  press: readonly PressView[];
  myOrders: string[];
  engineReady: boolean;
  connected: boolean;
  quoting: PressView | null;
  onUnquote: () => void;
  onSend: PressPanelProps["onSend"];
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sealing, setSealing] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sealed, setSealed] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const sealId = useId();
  const quoteId = useId();
  const gate = pressOpen(settings, status, phase, to);
  const left = to === "ALL" ? null : whispersLeft(press, me, phase, settings.whisperBudget);
  const spent = left === 0;
  const pledgeable = useMemo(() => myOrders.filter((o) => o !== "WAIVE"), [myOrders]);
  const pickable = status === "active" && engineReady && pledgeable.length > 0;

  // Choosing a message to quote puts the pen back in the player's hand.
  useEffect(() => {
    if (quoting) area.current?.focus();
  }, [quoting]);

  // Orders that are no longer written cannot stay chosen.
  useEffect(() => {
    setChosen((c) => {
      const kept = c.filter((o) => pledgeable.includes(o));
      return kept.length === c.length ? c : kept;
    });
  }, [pledgeable]);

  if (!gate.open) return <p className="talk-note">{gate.why}</p>;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (busy) return;
    if (!text) {
      setError(sealing ? "A seal travels with a message. Write a line to go with it." : "Write something first.");
      area.current?.focus();
      return;
    }
    if (sealing && chosen.length === 0) {
      setError("Choose at least one of your orders to put under the seal, or take the seal off.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pledge = sealing ? makeSeal(chosen, sealed) : undefined;
      await onSend(to, text, pledge, quoting?.id);
      setBody("");
      onUnquote();
      setSealing(false);
      setChosen([]);
    } catch (err) {
      setError(
        err instanceof CabalError
          ? err.code === "bad_pledge"
            ? `The seal was refused: ${err.message}.`
            : (ERRORS[err.code] ?? err.message)
          : "The message did not go through. Check your connection and send it again.",
      );
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const label = to === "ALL" ? "Message the table" : `Message ${threadLabel(to)}`;
  return (
    <form className="talk-compose press-compose" onSubmit={submit} noValidate>
      <label htmlFor={`compose-${to}`}>{label}</label>
      {quoting ? <QuotingSlip id={quoteId} quoting={quoting} me={me} onUnquote={onUnquote} /> : null}
      <textarea
        ref={area}
        id={`compose-${to}`}
        rows={2}
        maxLength={2000}
        value={body}
        disabled={spent}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        aria-describedby={[quoting ? quoteId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
      />
      {sealing ? (
        <fieldset className="seal-pick" aria-describedby={sealId}>
          <legend>Put under the seal</legend>
          <p className="fine" id={sealId}>
            A Seal is a promise about your own orders this phase. When the phase resolves the server stamps it kept or broken, and every reader opens the seal again on their own device. The server reads the orders when you send it; the seal keeps them from the other players.
          </p>
          <div className="seal-choices">
            {pledgeable.map((o) => (
              <label key={o} className="check">
                <input type="checkbox" checked={chosen.includes(o)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, o] : c.filter((x) => x !== o)))} />
                <code>{o}</code>
              </label>
            ))}
          </div>
          <div className="seal-mode" role="radiogroup" aria-label="How the orders travel">
            <label className="check">
              <input type="radio" name={`seal-mode-${to}`} checked={sealed} onChange={() => setSealed(true)} />
              <span>
                <strong>Sealed.</strong> They see the wax until the phase resolves.
              </span>
            </label>
            <label className="check">
              <input type="radio" name={`seal-mode-${to}`} checked={!sealed} onChange={() => setSealed(false)} />
              <span>
                <strong>Open.</strong> They read the orders now.
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}
      <div className="talk-row">
        <span className="fine">
          {spent
            ? "No private messages left this phase."
            : left !== null
              ? `${left} private ${left === 1 ? "message" : "messages"} left this phase.`
              : "Enter sends. Shift and Enter for a new line."}
        </span>
        {pickable ? (
          <button type="button" className="btn small seal-toggle" aria-pressed={sealing} onClick={() => setSealing((s) => !s)}>
            {sealing ? "Remove the seal" : "Attach a seal"}
          </button>
        ) : null}
        <button type="submit" className="btn" disabled={busy || spent || !connected}>
          {sealing ? "Send under seal" : "Send"}
        </button>
      </div>
      {error ? (
        <p className="form-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
