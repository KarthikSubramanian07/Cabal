/**
 * The parts of the room that tell the time. Each one subscribes to the second hand itself, so a
 * tick redraws a few characters of text, never the table around them (and never the board, whose
 * hundreds of paths React would otherwise compare every second for the whole game).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { clockFace, clockWords, urgency } from "./clock.js";

type Listener = () => void;

/** One shared second hand for every clock on the page: a single timer, however many listen. */
const listeners = new Set<Listener>();
let timer: number | null = null;
let now = Date.now();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

const read = () => now;
const never = () => () => undefined;

/**
 * The server's time now, redrawn every second while `on`. Every countdown runs on the server's
 * clock (`offsetMs` from the welcome and state frames), so two players read the same time.
 */
export function useServerNow(offsetMs: number, on = true): number {
  const local = useSyncExternalStore(on ? subscribe : never, read, read);
  return local + offsetMs;
}

interface Deadline {
  /** The phase deadline on the server's clock, or null without one. */
  deadlineAt: number | null;
  offsetMs: number;
}

/** The phase clock beside the phase's name: the time left, urgent in the last minutes. */
export function PhaseClock({ deadlineAt, offsetMs, paused, grace }: Deadline & { paused: boolean; grace: boolean }) {
  const serverNow = useServerNow(offsetMs, deadlineAt !== null && !paused);
  const msLeft = deadlineAt !== null ? deadlineAt - serverNow : null;
  const urgent = msLeft !== null ? urgency(msLeft) : "calm";
  return (
    <span className={`clock ${urgent}${grace ? " grace" : ""}`} aria-label={msLeft !== null ? `Time left: ${clockWords(msLeft)}` : "No deadline"}>
      {paused ? "Paused" : msLeft !== null ? clockFace(msLeft) : "No clock"}
      {grace ? <span className="grace-tag">Grace</span> : null}
    </span>
  );
}

/** The time left as the phone's sheet handle writes it: "9:41 left". */
export function SheetClock({ deadlineAt, offsetMs }: Deadline) {
  const serverNow = useServerNow(offsetMs, deadlineAt !== null);
  return <>{deadlineAt !== null ? `${clockFace(deadlineAt - serverNow)} left` : null}</>;
}

/**
 * Says the clock out loud at five minutes and at one, for people who cannot glance at it. It
 * draws nothing; it asks the room's live region to speak.
 */
export function ClockCrier({ deadlineAt, offsetMs, announce }: Deadline & { announce: (text: string) => void }) {
  const serverNow = useServerNow(offsetMs, deadlineAt !== null);
  const msLeft = deadlineAt !== null ? deadlineAt - serverNow : null;
  const lastSaid = useRef<number | null>(null);
  useEffect(() => {
    if (msLeft === null || msLeft > 5 * 60_000 || msLeft <= 0) return;
    const minute = Math.ceil(msLeft / 60_000);
    if (lastSaid.current === minute) return;
    lastSaid.current = minute;
    if (minute === 5 || minute === 1) announce(clockWords(msLeft));
  }, [msLeft, announce]);
  return null;
}
