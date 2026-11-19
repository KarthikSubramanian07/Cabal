/**
 * The live picture of one table, folded from the server's frames. Pure, so the lobby's and the
 * game room's view of the game is tested without a socket: `welcome` sets everything, and each
 * later frame changes only what it is about.
 */
import type {
  GameSettings,
  GameStatus,
  GameSummary,
  OrderResultView,
  PhaseSummary,
  PowerName,
  PressView,
  Receipt,
  SeatView,
  StateView,
  VotesView,
} from "@cabal/protocol";
import type { Frame } from "@cabal/protocol/client";

/** One phase as the server reported it resolving. */
export interface ResolvedPhase {
  phase: string;
  results: OrderResultView[];
  dislodged: { unit: string; attacker_from: string; retreat_options: string[] }[];
  standoffs: string[];
  civil_disorder: string[];
  summary: PhaseSummary;
  /** The board as the phase began, when this device saw it begin; null after a reload. */
  before: StateView | null;
}

export interface ExtendView {
  phase: string;
  requestedBy: PowerName[];
  needed: number;
  granted: boolean;
}

export interface RoomView {
  gameId: string;
  settings: GameSettings;
  status: GameStatus;
  host: PowerName;
  phase: string;
  state: StateView | null;
  seats: SeatView[];
  deadlineAt: number | null;
  /** True when the current deadline is the one-off grace period. */
  grace: boolean;
  pauseReason: string | null;
  /** The viewer's seat as the server sees it; null for a spectator. */
  power: PowerName | null;
  /** Press the viewer may read, oldest first, each message once, pledges kept up to date. */
  press: PressView[];
  /** Older press exists on the server than `press` holds. */
  pressMore: boolean;
  /** Unread messages per thread (`ALL` or the other power), as the server counts them. */
  unread: Record<string, number>;
  /** The viewer's own orders on file for `phase`, as the server last confirmed them. */
  orders: string[];
  /** The phase `orders` belong to. */
  ordersPhase: string;
  votes: VotesView | null;
  /** Every resolved phase, oldest first. */
  history: PhaseSummary[];
  /** The phases this device has seen resolve, keyed by phase name. */
  resolved: Record<string, ResolvedPhase>;
  /** The latest phase this device saw resolve, for the results moment. */
  lastResolved: string | null;
  extend: ExtendView | null;
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
    grace: false,
    pauseReason: s.pauseReason,
    power: null,
    press: [],
    pressMore: false,
    unread: {},
    orders: [],
    ordersPhase: s.phase,
    votes: null,
    history: s.history,
    resolved: {},
    lastResolved: null,
    extend: null,
    clockOffsetMs: s.serverTime - now,
    finished: s.finished,
  };
}

function addPress(list: PressView[], message: PressView): PressView[] {
  const at = list.findIndex((m) => m.id === message.id);
  if (at >= 0) {
    // The same message again (a resume, a reply to the sender): keep the newest view of its pledge.
    // A stamped receipt is never replaced by an older, unstamped copy.
    const known = list[at]!;
    if (!message.pledge || (known.pledge?.receipt && !message.pledge.receipt)) return list;
    if (JSON.stringify(known.pledge) === JSON.stringify(message.pledge)) return list;
    const next = [...list];
    next[at] = { ...known, pledge: message.pledge };
    return next;
  }
  const next = [...list, message];
  next.sort((a, b) => a.sentAt - b.sentAt);
  return next;
}

/** Stamp a receipt on the pledge it belongs to, revealing its orders and the nonce that opens it. */
function stampReceipt(list: PressView[], pledgeId: string, receipt: Receipt, revealed: string[] | null, nonce: string): PressView[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.pledge?.id !== pledgeId) return m;
    changed = true;
    return { ...m, pledge: { ...m.pledge, receipt, nonce, orders: revealed ?? m.pledge.orders } };
  });
  return changed ? next : list;
}

function addSummary(history: PhaseSummary[], summary: PhaseSummary): PhaseSummary[] {
  if (history.some((h) => h.phase === summary.phase)) return history;
  return [...history, summary];
}

/** Apply one frame. Frames the room does not draw leave the view as it was (same object). */
export function applyFrame(view: RoomView | null, frame: Frame, now: number): RoomView | null {
  if (frame.t === "welcome") {
    const p = frame.p;
    const same = view?.gameId === p.gameId;
    return {
      gameId: p.gameId,
      settings: p.settings,
      status: p.status,
      host: p.host,
      phase: p.phase,
      state: p.state,
      seats: p.seats,
      deadlineAt: p.deadlineAt,
      grace: same && view.phase === p.phase ? view.grace : false,
      pauseReason: p.pauseReason ?? null,
      power: p.power,
      // A reconnect's welcome is the truth, but messages already shown stay where they are.
      press: p.press.reduce(addPress, same ? view.press : []),
      pressMore: p.pressMore,
      unread: p.unread,
      orders: p.orders,
      ordersPhase: p.phase,
      votes: p.votes,
      history: p.history,
      resolved: same ? view.resolved : {},
      lastResolved: same ? view.lastResolved : null,
      extend: same && view.extend?.phase === p.phase ? view.extend : null,
      clockOffsetMs: p.serverTime - now,
      finished: p.finished,
    };
  }
  if (!view) return view;
  switch (frame.t) {
    case "seats":
      return { ...view, seats: frame.p.seats };
    case "press": {
      const press = addPress(view.press, frame.p);
      if (press === view.press) return view;
      // A message from someone else counts as unread until its thread is opened (see markRead).
      const fresh = press.length > view.press.length && frame.p.from !== view.power;
      const thread = frame.p.to === "ALL" ? "ALL" : frame.p.from;
      return { ...view, press, unread: fresh ? { ...view.unread, [thread]: (view.unread[thread] ?? 0) + 1 } : view.unread };
    }
    case "press.unread":
      return { ...view, unread: frame.p.unread };
    case "pledge.receipt": {
      const press = stampReceipt(view.press, frame.p.pledgeId, frame.p.receipt, frame.p.revealed, frame.p.nonce);
      return press === view.press ? view : { ...view, press };
    }
    case "orders.ack":
      return frame.p.phase === view.phase ? { ...view, orders: frame.p.accepted, ordersPhase: frame.p.phase } : view;
    case "state": {
      const moved = frame.p.phase !== view.phase;
      return {
        ...view,
        phase: frame.p.phase,
        state: frame.p.state,
        deadlineAt: frame.p.deadlineAt,
        status: frame.p.status,
        clockOffsetMs: frame.p.serverTime - now,
        ...(moved ? { orders: [], ordersPhase: frame.p.phase, grace: false, extend: null } : {}),
      };
    }
    case "results": {
      const p = frame.p;
      const resolved: ResolvedPhase = {
        phase: p.phase,
        results: p.results,
        dislodged: p.dislodged,
        standoffs: p.standoffs,
        civil_disorder: p.civil_disorder,
        summary: p.summary,
        before: view.state && view.state.name === p.phase ? view.state : null,
      };
      return {
        ...view,
        resolved: { ...view.resolved, [p.phase]: resolved },
        lastResolved: p.phase,
        history: addSummary(view.history, p.summary),
        // The votes belonged to the phase that has just resolved.
        votes: view.votes ? { ...view.votes, draw: [], cast: 0, yes: 0 } : view.votes,
      };
    }
    case "votes":
      return { ...view, votes: frame.p };
    case "status":
      return { ...view, status: frame.p.status, pauseReason: frame.p.status === "paused" ? frame.p.reason : null };
    case "deadline":
      return {
        ...view,
        deadlineAt: frame.p.deadlineAt,
        grace: frame.p.phase === view.phase ? Boolean(frame.p.grace) : false,
        clockOffsetMs: frame.p.serverTime - now,
      };
    case "extend":
      return {
        ...view,
        extend: { phase: frame.p.phase, requestedBy: frame.p.requestedBy, needed: frame.p.needed, granted: frame.p.granted },
        deadlineAt: frame.p.deadlineAt ?? view.deadlineAt,
      };
    case "finished":
      return {
        ...view,
        status: frame.p.result === "abandoned" ? "abandoned" : "finished",
        deadlineAt: null,
        finished: { result: frame.p.result, winners: frame.p.winners, scores: frame.p.scores, reason: frame.p.reason ?? null },
      };
    default:
      return view;
  }
}

/** The viewer has read a thread up to now: the count the server will confirm, at once. */
export function markThreadRead(view: RoomView, thread: string): RoomView {
  if (!view.unread[thread]) return view;
  return { ...view, unread: { ...view.unread, [thread]: 0 } };
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
