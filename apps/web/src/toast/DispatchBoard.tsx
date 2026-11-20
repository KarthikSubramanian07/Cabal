/**
 * The dispatch board: slips pinned to the edge of the room when something happens out of sight.
 * A slip never takes focus and never blocks the board; it says its news to screen readers once,
 * waits while the pointer or focus is on it, and goes on its own after a while. Everything on a
 * slip is also in the room itself (the thread's unread count, the results, the seal's stamp), so
 * a slip that leaves takes nothing with it.
 */
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { RoomView } from "../lobby/room.js";
import { type Dispatch, type DispatchContext, pinDispatches, roomDispatches } from "./dispatches.js";

/** How long a slip stays up untouched. A receipt is worth reading twice. */
const STAY_MS: Record<Dispatch["kind"], number> = { press: 9_000, resolved: 7_000, receipt: 14_000 };

const STAMP: Record<string, string> = { kept: "Kept", broken: "Broken", void: "Void" };

export interface Dispatches {
  up: Dispatch[];
  /** The latest news in words, for the board's live region. */
  said: string;
  dismiss: (key: string) => void;
}

/** Watch the room for news and keep the slips that are up. */
export function useDispatches(view: RoomView, ctx: DispatchContext): Dispatches {
  const [up, setUp] = useState<Dispatch[]>([]);
  const [said, setSaid] = useState("");
  const before = useRef(view);
  const context = useRef(ctx);
  context.current = ctx;

  useEffect(() => {
    const prev = before.current;
    before.current = view;
    if (prev === view) return;
    const news = roomDispatches(prev, view, context.current);
    if (news.length === 0) return;
    setUp((current) => pinDispatches(current, news));
    const words = news.map((d) => d.say).filter((s): s is string => Boolean(s));
    if (words.length) setSaid(words.join(" "));
  }, [view]);

  // Opening a thread reads it: its slip has nothing more to say.
  useEffect(() => {
    const reading = ctx.reading;
    if (reading) setUp((current) => (current.some((d) => d.kind === "press" && d.thread === reading) ? current.filter((d) => !(d.kind === "press" && d.thread === reading)) : current));
  }, [ctx.reading]);

  const dismiss = useCallback((key: string) => setUp((current) => current.filter((d) => d.key !== key)), []);
  return { up, said, dismiss };
}

export function DispatchBoard({ dispatches, onOpen }: { dispatches: Dispatches; onOpen: (d: Dispatch) => void }) {
  const { up, said, dismiss } = dispatches;
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      {up.length ? (
        <section className="dispatch-board" aria-label="News from the table">
          <ol>
            {up.map((d) => (
              <Slip key={d.key} d={d} onOpen={onOpen} onDismiss={dismiss} />
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Slip({ d, onOpen, onDismiss }: { d: Dispatch; onOpen: (d: Dispatch) => void; onDismiss: (key: string) => void }) {
  const [held, setHeld] = useState(false);
  const self = useRef<HTMLLIElement>(null);

  // Gone after a while, unless the player is reading it. New words for the slip start the wait again.
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => onDismiss(d.key), STAY_MS[d.kind]);
    return () => window.clearTimeout(timer);
  }, [held, d.key, d.kind, d.count, d.line, onDismiss]);

  const release = () => {
    // Focus moving within the slip keeps it held.
    window.setTimeout(() => {
      const el = self.current;
      if (el && !el.matches(":hover") && !el.contains(document.activeElement)) setHeld(false);
    }, 0);
  };

  const style = { "--power": d.power ? `var(--p-${d.power.toLowerCase()})` : "var(--brass)" } as CSSProperties;
  return (
    <li
      ref={self}
      className={`slip kind-${d.kind}${d.stamp ? ` stamped ${d.stamp}` : ""}`}
      style={style}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={release}
      onFocus={() => setHeld(true)}
      onBlur={release}
    >
      <div className="slip-text">
        <p className="slip-title">{d.title}</p>
        <p className="slip-line">{d.line}</p>
      </div>
      {d.stamp ? (
        <span className={`rubber small ${d.stamp}`} role="img" aria-label={`Receipt: ${STAMP[d.stamp]}`}>
          {STAMP[d.stamp]}
        </span>
      ) : null}
      <div className="slip-acts">
        <button type="button" className="btn small" onClick={() => onOpen(d)}>
          {d.kind === "resolved" ? "See the results" : d.kind === "receipt" ? "See the seal" : "Read it"}
        </button>
        <button type="button" className="slip-close" onClick={() => onDismiss(d.key)}>
          <span aria-hidden="true">×</span>
          <span className="sr-only">Dismiss: {d.title}</span>
        </button>
      </div>
    </li>
  );
}
