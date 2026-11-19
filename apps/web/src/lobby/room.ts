/**
 * The live picture of one table, folded from the server's frames. Pure, so the lobby's view of
 * the game is tested without a socket: `welcome` sets everything, and each later frame changes
 * only what it is about.
 */
import type { GameSettings, GameStatus, GameSummary, PowerName, PressView, SeatView, StateView } from "@cabal/protocol";
import type { Frame } from "@cabal/protocol/client";

export interface RoomView {
  gameId: string;
  settings: GameSettings;
  status: GameStatus;
  host: PowerName;
  phase: string;
  state: StateView | null;
  seats: SeatView[];
  deadlineAt: number | null;
  /** The viewer's seat as the server sees it; null for a spectator. */
  power: PowerName | null;
  /** Public press the viewer may read, oldest first, each message once. */
  press: PressView[];
  /** Server clock minus this device's clock. */
  clockOffsetMs: number;
  finished: GameSummary["finished"];
}

/** A first picture from `GET /api/games/:id`, before the socket has said anything. */
export function fromSummary(s: GameSummary, now: number): RoomView {
  return {
    gameId: s.id,
    settings: s.settings,
    status: s.status,
    host: s.host,
    phase: s.phase,
    state: null,
    seats: s.seats,
    deadlineAt: s.deadlineAt,
    power: null,
    press: [],
    clockOffsetMs: s.serverTime - now,
    finished: s.finished,
  };
}

function addPress(list: PressView[], message: PressView): PressView[] {
  if (list.some((m) => m.id === message.id)) return list;
  const next = [...list, message];
  next.sort((a, b) => a.sentAt - b.sentAt);
  return next;
}

/** Apply one frame. Frames the lobby does not draw leave the view as it was (same object). */
export function applyFrame(view: RoomView | null, frame: Frame, now: number): RoomView | null {
  if (frame.t === "welcome") {
    const p = frame.p;
    return {
      gameId: p.gameId,
      settings: p.settings,
      status: p.status,
      host: p.host,
      phase: p.phase,
      state: p.state,
      seats: p.seats,
      deadlineAt: p.deadlineAt,
      power: p.power,
      // A reconnect's welcome is the truth, but messages already shown stay where they are.
      press: p.press.reduce(addPress, view?.gameId === p.gameId ? view.press : []),
      clockOffsetMs: p.serverTime - now,
      finished: p.finished,
    };
  }
  if (!view) return view;
  switch (frame.t) {
    case "seats":
      return { ...view, seats: frame.p.seats };
    case "press":
      return { ...view, press: addPress(view.press, frame.p) };
    case "state":
      return {
        ...view,
        phase: frame.p.phase,
        state: frame.p.state,
        deadlineAt: frame.p.deadlineAt,
        status: frame.p.status,
        clockOffsetMs: frame.p.serverTime - now,
      };
    case "status":
      return { ...view, status: frame.p.status };
    case "deadline":
      return { ...view, deadlineAt: frame.p.deadlineAt, clockOffsetMs: frame.p.serverTime - now };
    case "finished":
      return {
        ...view,
        status: frame.p.result === "abandoned" ? "abandoned" : "finished",
        finished: { result: frame.p.result, winners: frame.p.winners, scores: frame.p.scores, reason: frame.p.reason ?? null },
      };
    default:
      return view;
  }
}

/** Seats still waiting for a player. */
export function openSeats(view: Pick<RoomView, "seats">): SeatView[] {
  return view.seats.filter((s) => s.kind === "open");
}

/** Seats a person holds. */
export function humanSeats(view: Pick<RoomView, "seats">): SeatView[] {
  return view.seats.filter((s) => s.kind === "human");
}

/**
 * Whether the host may start now, and if not, why. The server makes the same check: with AI
 * fill off, every seat needs a player first.
 */
export function canStart(view: Pick<RoomView, "seats" | "settings" | "status">): { ok: boolean; why: string | null } {
  if (view.status !== "lobby") return { ok: false, why: "The game has already started." };
  const open = openSeats(view).length;
  if (open > 0 && !view.settings.aiFill) {
    return { ok: false, why: `${open} seat${open === 1 ? " is" : "s are"} still open, and this table waits for players.` };
  }
  return { ok: true, why: null };
}
