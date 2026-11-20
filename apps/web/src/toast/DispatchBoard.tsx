/**
 * The dispatch board: slips pinned to the edge of the room when something happens out of sight.
 * A slip never takes focus and never blocks the board; it says its news to screen readers once,
 * waits while the pointer or focus is on it, and goes on its own after a while. Everything on a
 * slip is also in the room itself (the thread's unread count, the results, the seal's stamp), so
 * a slip that leaves takes nothing with it.
 *
 * The board is at the end of the page, so a keyboard has a shortcut to it: N (for news) moves focus
 * to the newest slip, and again to the one before it. Focus on a slip holds it, as hovering does.
 */
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import { useShortcuts } from "../app/prefs.js";
import type { RoomView } from "../lobby/room.js";
import { type Dispatch, type DispatchContext, pinDispatches, roomDispatches } from "./dispatches.js";

/** How long a slip stays up untouched. A receipt is worth reading twice. */
const STAY_MS: Record<Dispatch["kind"], number> = { press: 9_000, resolved: 7_000, receipt: 14_000 };

const STAMP: Record<string, string> = { kept: "Kept", broken: "Broken", void: "Void" };

export interface Dispatches {
  up: Dispatch[];
  /** The latest news in words, for the board's live region. */
  said: string;
  /** Say something through the board's live region. */
  say: (words: string) => void;
  dismiss: (key: string) => void;
}

/** The key that moves focus to the slips (with the other single-key shortcuts, see HowToPlay). */
export const NEWS_KEY = "n";

/**
 * Which slip the news key moves to, of `count` slips listed oldest first: the newest, or, from a
 * slip, the one before it, round again to the newest after the oldest. -1 when there are none.
 */
export function newsTarget(count: number, current: number): number {
  if (count <= 0) return -1;
  return current > 0 && current < count ? current - 1 : count - 1;
}

/**
 * The news key, pressed: focus the slip `newsTarget` names (its first action), or say why there is
 * none to go to. `root` is the document the board is in.
 */
export function focusNews(say: (words: string) => void, root: Document = document): void {
  const board = root.querySelector<HTMLElement>(".dispatch-board");
  if (!board) return say("No news from the table.");
  if (board.hidden) return say("The news waits until the order sheet is closed.");
  const slips = [...board.querySelectorAll<HTMLElement>(".slip")];
  const current = slips.findIndex((slip) => slip.contains(root.activeElement));
  slips[newsTarget(slips.length, current)]?.querySelector<HTMLElement>(".slip-acts button")?.focus();
}

/** Watch the room for news and keep the slips that are up. */
export function useDispatches(view: RoomView, ctx: DispatchContext): Dispatches {
  const [up, setUp] = useState<Dispatch[]>([]);
  const [said, setSaid] = useState("");
  const before = useRef(view);
  const context = useRef(ctx);
  context.current = ctx;
  const saying = useRef<number | null>(null);

  // The same words twice (a second message from the same power) must still be said twice: the
  // region is emptied first and filled a moment later, so it changes every time.
  const say = useCallback((words: string) => {
    if (saying.current !== null) window.clearTimeout(saying.current);
    setSaid("");
    saying.current = window.setTimeout(() => {
      saying.current = null;
      setSaid(words);
    }, 50);
  }, []);
  useEffect(
    () => () => {
      if (saying.current !== null) window.clearTimeout(saying.current);
    },
    [],
  );

  useEffect(() => {
    const prev = before.current;
    before.current = view;
    if (prev === view) return;
    const news = roomDispatches(prev, view, context.current);
    if (news.length === 0) return;
    setUp((current) => pinDispatches(current, news));
    const words = news.map((d) => d.say).filter((s): s is string => Boolean(s));
    if (words.length) say(words.join(" "));
  }, [view, say]);

  // Opening a thread reads it: its slip has nothing more to say.
  useEffect(() => {
    const reading = ctx.reading;
    if (reading) setUp((current) => (current.some((d) => d.kind === "press" && d.thread === reading) ? current.filter((d) => !(d.kind === "press" && d.thread === reading)) : current));
  }, [ctx.reading]);

  const dismiss = useCallback((key: string) => setUp((current) => current.filter((d) => d.key !== key)), []);
  return { up, said, say, dismiss };
}

/**
 * `tucked`: the order sheet is open over a phone's map, and a slip would sit on its header (its
 * Close button, the phase, the clock). The slips wait out of sight, their time stopped, until the
 * sheet closes; the news is still said, and the sheet's own tabs count the unread messages.
 */
export function DispatchBoard({ dispatches, tucked = false, onOpen }: { dispatches: Dispatches; tucked?: boolean; onOpen: (d: Dispatch) => void }) {
  const { up, said, dismiss } = dispatches;
  return (
    <>
      <div className="sr-only dispatch-said" role="status" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      {up.length ? (
        <section className="dispatch-board" aria-label="News from the table" hidden={tucked}>
          <ol>
            {up.map((d, i) => (
              <Slip key={d.key} d={d} newest={i === up.length - 1} paused={tucked} onOpen={onOpen} onDismiss={dismiss} />
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Slip({ d, newest, paused, onOpen, onDismiss }: { d: Dispatch; newest: boolean; paused: boolean; onOpen: (d: Dispatch) => void; onDismiss: (key: string) => void }) {
  const [shortcuts] = useShortcuts();
  const [held, setHeld] = useState(false);
  const self = useRef<HTMLLIElement>(null);
  const titleId = useId();

  // Gone after a while, unless the player is reading it or it is tucked away unseen. New words for
  // the slip, or the slip coming back into sight, start the wait again.
  useEffect(() => {
    if (held || paused) return;
    const timer = window.setTimeout(() => onDismiss(d.key), STAY_MS[d.kind]);
    return () => window.clearTimeout(timer);
  }, [held, paused, d.key, d.kind, d.count, d.line, onDismiss]);

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
        <p className="slip-title" id={titleId}>
          {d.title}
        </p>
        <p className="slip-line">{d.line}</p>
      </div>
      {d.stamp ? (
        <span className={`rubber small ${d.stamp}`} role="img" aria-label={`Receipt: ${STAMP[d.stamp]}`}>
          {STAMP[d.stamp]}
        </span>
      ) : null}
      <div className="slip-acts">
        <button type="button" className="btn small" onClick={() => onOpen(d)} aria-keyshortcuts={newest && shortcuts ? NEWS_KEY.toUpperCase() : undefined}>
          {d.kind === "resolved" ? "See the results" : d.kind === "receipt" ? "See the seal" : "Read it"}
          {/* The key, shown as the order tools show theirs; said through aria-keyshortcuts instead. */}
          {newest && shortcuts ? (
            <kbd className="keys-only" aria-hidden="true">
              {NEWS_KEY.toUpperCase()}
            </kbd>
          ) : null}
        </button>
        {/* Named "Dismiss" alone, and described by the slip's title, so it says which slip it closes. */}
        <button type="button" className="slip-close" aria-label="Dismiss" aria-describedby={titleId} onClick={() => onDismiss(d.key)}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </li>
  );
}
