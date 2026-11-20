/**
 * The order desk of a seat in a live game: the same order book, composer and legal lists the
 * sandbox uses, for one power, kept in step with the server.
 *
 *  - Legal orders come from the engine running here, on the board the server last sent, so the
 *    map offers exactly what the server will accept and answers at once.
 *  - Every change is filed with the server shortly after it is made (`orders.set` replaces the
 *    seat's list), and the server's verdict on each order is kept for the order list.
 *  - Orders written while the connection is down stay on this device and are filed when it
 *    comes back. They are kept in storage too (drafts.ts) until the server acknowledges them, so
 *    leaving the room or closing the tab first does not lose them: reopening puts them back and
 *    files them. Changing orders after saying "ready" takes the ready back first, so a phase can
 *    never resolve on orders the player is still changing.
 */
import type { OrderVerdict as ServerVerdict, PowerName, StateView } from "@cabal/protocol";
import type { ConnectionStatus, Frame } from "@cabal/protocol/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Game, type OrderVerdict, type State, engineReady } from "../engine.js";
import { type OrderBook, eraseOrder, toBook, waiveBuild, writeOrder } from "../game/book.js";
import type { ComposeContext, Piece } from "../game/compose.js";
import { type PhaseKind, parseUnit, phaseKind } from "../game/notation.js";
import { tidyLegal } from "../game/saved.js";
import { type Board, loadBoard } from "../map/boardData.js";
import { clearDraft, readDraft, writeDraft } from "./drafts.js";
import { type Everyone, NOBODY, legalForEveryone } from "./sketch.js";
import { settledBook } from "./settle.js";

export type SyncState =
  /** Every order on this device is on file with the server. */
  | "filed"
  /** A change is waiting to be filed (briefly, or until the connection returns). */
  | "pending"
  | "saving"
  /** The server refused the last filing as a whole (a stale phase, a seat that cannot act). */
  | "failed";

export interface Desk {
  board: Board;
  /**
   * The rules engine has arrived. The board is drawn from the map alone, before it: until then
   * there are no legal orders to offer, and nothing can be settled or judged.
   */
  rulesReady: boolean;
  kind: PhaseKind;
  pieces: Piece[];
  /** Legal orders for the seat's power, by unit (adjustments under `""`). */
  legal: Record<string, string[]>;
  allowance: number;
  /** The seat's orders on this device. */
  book: Record<string, string>;
  ctx: ComposeContext;
  sync: SyncState;
  /** The server's verdicts on the last filing, by the text that was sent. */
  verdicts: Record<string, ServerVerdict>;
  /** A sentence when the last filing failed. */
  syncError: string | null;
  setOrder: (key: string, text: string) => void;
  removeOrder: (key: string) => void;
  clearOrders: () => void;
  holdAll: () => void;
  waive: () => void;
  /** File everything now, with every open decision written out (holds, disbands, waives). */
  settle: () => Promise<boolean>;
  /** The engine's verdict on one typed order: canonical text, legal, and why not. */
  judge: (text: string) => OrderVerdict;
  /**
   * Legal orders and allowances for every power on the board, for a what-if sketch that guesses
   * at the other powers' orders. Worked out on first asking, once per board.
   */
  everyone: () => Everyone;
  /** `judge` for any power: what a typed guess for another power means. */
  judgeAs: (power: string, text: string) => OrderVerdict;
}

export type DeskLoad = { status: "loading" } | { status: "error"; error: Error; retry: () => void } | { status: "ready"; desk: Desk };

interface Props {
  /** The game's code: drafts are kept per game and seat. */
  gameId: string;
  power: PowerName | null;
  phase: string;
  state: StateView | null;
  rulebook: string;
  /** The orders the server has on file for `serverPhase`. */
  serverOrders: string[];
  serverPhase: string;
  /** Whether this seat has said it is ready. */
  ready: boolean;
  /** The seat can file orders now (a seat, a running game, a phase it has something to do in). */
  canOrder: boolean;
  connection: ConnectionStatus;
  file: (phase: string, orders: string[]) => Promise<Frame<"orders.ack">>;
  unready: (phase: string) => void;
}

/** Board pieces from a state, dislodged units marked. */
export function piecesOf(state: Pick<State, "units">): Piece[] {
  const list: Piece[] = [];
  for (const [power, units] of Object.entries(state.units)) {
    for (const u of units) {
      const ref = parseUnit(u);
      if (ref) list.push({ power, unit: ref.unit, province: ref.province, dislodged: u.startsWith("*") });
    }
  }
  return list;
}

/** A seat's orders as the order book keys them. */
export function bookOf(power: string, orders: readonly string[], kind: PhaseKind): Record<string, string> {
  return toBook({ [power]: [...orders] }, kind)[power] ?? {};
}

/** Two books with the same orders, whatever their keys' order. */
export function sameOrders(a: Record<string, string>, b: Record<string, string>): boolean {
  const x = Object.values(a).sort();
  const y = Object.values(b).sort();
  return x.length === y.length && x.every((o, i) => o === y[i]);
}

export function useDesk(props: Props): DeskLoad {
  const { gameId, power, phase, state, rulebook, serverOrders, serverPhase, ready, canOrder, connection, file, unready } = props;
  const [board, setBoard] = useState<Board | null>(null);
  const [engine, setEngine] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The map first, and the engine once the map is in: the board is on screen while the rules,
  // a megabyte of WebAssembly, are still on their way, rather than both arriving together.
  useEffect(() => {
    let live = true;
    setError(null);
    const fail = (err: unknown) => live && setError(err instanceof Error ? err : new Error(String(err)));
    loadBoard().then((b) => {
      if (!live) return;
      setBoard(b);
      engineReady().then(() => live && setEngine(true), fail);
    }, fail);
    return () => {
      live = false;
    };
  }, [attempt]);

  const kind = phaseKind(phase);

  // The engine on the board as the server sees it. Rebuilt only when the board changes.
  const game = useMemo(() => {
    if (!engine || !state) return null;
    try {
      return Game.fromState(state as unknown as State, rulebook);
    } catch {
      return null;
    }
  }, [engine, state, rulebook]);

  const { legal, allowance } = useMemo(() => {
    if (!game || !power || game.status() !== "active") return { legal: {} as Record<string, string[]>, allowance: 0 };
    const l = game.legal(power);
    return { legal: tidyLegal(l.by_unit, kind), allowance: l.allowance };
  }, [game, power, kind]);

  const pieces = useMemo(() => (state ? piecesOf(state as unknown as State) : []), [state]);

  // ---- the book, kept in step with the server

  const [book, setBook] = useState<Record<string, string>>({});
  const [bookPhase, setBookPhase] = useState(phase);
  /** Bumped by every change the player makes; the filing effect sends the latest. */
  const [edits, setEdits] = useState(0);
  const [sync, setSync] = useState<SyncState>("filed");
  const [verdicts, setVerdicts] = useState<Record<string, ServerVerdict>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const filed = useRef(0);
  const editsNow = useRef(0);
  editsNow.current = edits;

  // A new phase starts with the server's orders (none, usually). Within a phase, the server's
  // copy wins whenever nothing written here is waiting to be filed: another device may have
  // changed the orders, and a reconnect's welcome is the truth.
  useEffect(() => {
    if (!power) return;
    if (phase !== bookPhase) {
      setBookPhase(phase);
      setBook(serverPhase === phase ? bookOf(power, serverOrders, kind) : {});
      setVerdicts({});
      setSync("filed");
      setSyncError(null);
      filed.current = edits;
      return;
    }
    if (serverPhase !== phase || filed.current !== edits) return;
    setBook((current) => {
      const next = bookOf(power, serverOrders, kind);
      return sameOrders(current, next) ? current : next;
    });
  }, [power, phase, bookPhase, serverPhase, serverOrders, kind, edits]);

  const timer = useRef<number | null>(null);
  /** The filing waiting out its pause, to be sent at once if the desk goes away first. */
  const waiting = useRef<(() => void) | null>(null);

  /** Send `orders` as edit number `sending`. Resolves true once the server has them on file. */
  const send = useCallback(
    (orders: string[], sending: number): Promise<boolean> => {
      setSync("saving");
      return file(phase, orders).then(
        (ack) => {
          filed.current = Math.max(filed.current, sending);
          setVerdicts(Object.fromEntries(ack.p.verdicts.map((v) => [v.text, v])));
          setSyncError(null);
          setSync(filed.current === editsNow.current ? "filed" : "pending");
          return true;
        },
        (err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === "disconnected" || code === "not_connected" || code === "timeout") {
            // Kept here; filed when the connection is back.
            setSync("pending");
            return false;
          }
          filed.current = Math.max(filed.current, sending);
          setSync("failed");
          setSyncError(
            code === "stale_phase"
              ? "The phase moved on before these orders arrived."
              : code === "seat_inactive"
                ? "This seat cannot give orders right now."
                : "The server would not take these orders. Try again.",
          );
          return false;
        },
      );
    },
    [file, phase],
  );

  // File the latest change after a short pause, or as soon as the connection is back.
  useEffect(() => {
    if (!power || filed.current === edits || bookPhase !== phase) return;
    if (!canOrder || connection !== "open") {
      setSync("pending");
      return;
    }
    const sending = edits;
    const orders = Object.values(book);
    setSync("pending");
    const fileNow = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      waiting.current = null;
      if (ready) unready(phase);
      void send(orders, sending);
    };
    waiting.current = fileNow;
    timer.current = window.setTimeout(fileNow, 350);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      waiting.current = null;
    };
    // `ready` is read, not watched: becoming ready must not refile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, connection, canOrder, power, phase, bookPhase]);

  // Leaving the room (a seat's record opened from the strip, say) inside the pause files what is
  // waiting at once instead of dropping it. A layout effect's cleanup runs before the room's
  // socket is closed by the page's own effects, so the orders still go out on it.
  useLayoutEffect(
    () => () => {
      waiting.current?.();
    },
    [],
  );

  const latest = useRef(book);
  latest.current = book;

  // ---- orders kept on this device until the server has them (drafts.ts)

  /** The game, seat and phase whose draft has been looked for. */
  const draftFor = useRef<string | null>(null);
  const draftKey = power ? `${gameId}|${power}|${phase}` : null;

  // On opening the room, and at each new phase: orders this device wrote and never got on file
  // are put back, and filed as soon as the connection allows. This comes after the effect that
  // takes the server's copy, so that when both run in one pass the orders put back are what stay.
  useEffect(() => {
    if (!power || !draftKey || draftFor.current === draftKey) return;
    draftFor.current = draftKey;
    const draft = readDraft(gameId, power, phase);
    if (!draft) return;
    const server = serverPhase === phase ? bookOf(power, serverOrders, kind) : {};
    if (sameOrders(draft.book, server)) {
      clearDraft(gameId, power);
      return;
    }
    latest.current = draft.book;
    setBook(draft.book);
    setEdits((n) => n + 1);
  }, [gameId, power, phase, draftKey, serverPhase, serverOrders, kind]);

  // Every change not yet acknowledged is written down; once the server has it all, the draft goes.
  useEffect(() => {
    if (!power || draftFor.current !== draftKey || bookPhase !== phase) return;
    // Orders were just put back from the draft: this pass still holds the book before them.
    if (latest.current !== book) return;
    if (sync !== "filed" || filed.current !== edits) writeDraft({ gameId, power, phase, book, savedAt: Date.now() });
    else clearDraft(gameId, power);
  }, [gameId, power, phase, draftKey, bookPhase, book, sync, edits]);
  const change = useCallback((next: (b: OrderBook) => OrderBook) => {
    if (!power) return;
    const current = latest.current;
    const out = next({ [power]: current })[power] ?? {};
    if (out === current) return;
    latest.current = out;
    setBook(out);
    setEdits((n) => n + 1);
  }, [power]);

  const setOrder = useCallback(
    (key: string, text: string) => change((b) => writeOrder(b, power!, key, text, { kind, allowance })),
    [change, power, kind, allowance],
  );
  const removeOrder = useCallback((key: string) => change((b) => eraseOrder(b, power!, key)), [change, power]);
  const clearOrders = useCallback(() => change((b) => (Object.keys(b[power!] ?? {}).length ? { [power!]: {} } : b)), [change, power]);
  const holdAll = useCallback(() => {
    if (kind !== "M") return;
    change((b) => {
      const next = { ...b[power!] };
      let added = false;
      for (const unit of Object.keys(legal)) {
        if (next[unit] === undefined) {
          next[unit] = `${unit} H`;
          added = true;
        }
      }
      return added ? { [power!]: next } : b;
    });
  }, [change, power, kind, legal]);
  const waive = useCallback(() => {
    if (kind === "A") change((b) => waiveBuild(b, power!, allowance));
  }, [change, power, kind, allowance]);

  /**
   * Make the orders final before saying ready: every decision left open is written as an order
   * (holds, disbands, waives; see settle.ts) so the server counts the seat as having ordered, and
   * whatever is waiting is filed now rather than after the pause. Resolves true once the server has it all on file.
   */
  const settle = useCallback(async (): Promise<boolean> => {
    // Without the rules there is no telling which decisions are still open.
    if (!power || !game) return false;
    const disorder = () => {
      try {
        // The rules' own choice: the phase resolved on this seat's orders alone.
        return game?.preview({ orders: { [power]: Object.values(latest.current) } }).civil_disorder ?? [];
      } catch {
        return [];
      }
    };
    const out = settledBook({ kind, book: latest.current, legal, allowance, disorder });
    let sending = editsNow.current;
    if (out !== latest.current) {
      sending += 1;
      latest.current = out;
      editsNow.current = sending;
      setBook(out);
      setEdits(sending);
    }
    if (filed.current === sending) return true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    // Claimed now, so the filing effect does not send the same change a second time.
    const before = filed.current;
    filed.current = sending;
    const ok = await send(Object.values(out), sending);
    if (!ok && filed.current === sending) filed.current = before;
    return ok;
  }, [power, kind, legal, allowance, game, send]);

  const judge = useCallback(
    (text: string): OrderVerdict => {
      if (!game || !power) return { input: text, canonical: null, legal: false, code: "unparseable", reason: engine ? "The board is not ready." : "The rules are still loading. Try again in a moment.", unit: null };
      return game.validateOrders(power, [text])[0]!;
    },
    [game, power, engine],
  );

  const everyoneCache = useRef<{ game: Game | null; value: Everyone } | null>(null);
  const everyone = useCallback((): Everyone => {
    if (!game) return NOBODY;
    if (everyoneCache.current?.game !== game) everyoneCache.current = { game, value: legalForEveryone(game, kind) };
    return everyoneCache.current.value;
  }, [game, kind]);

  const judgeAs = useCallback(
    (as: string, text: string): OrderVerdict => {
      if (!game) return { input: text, canonical: null, legal: false, code: "unparseable", reason: "The rules are still loading. Try again in a moment.", unit: null };
      return game.validateOrders(as, [text])[0]!;
    },
    [game],
  );

  const ctx = useMemo<ComposeContext>(
    () => ({
      phase: kind,
      pieces,
      legal: power ? { [power]: legal } : {},
      active: power ?? undefined,
      allowance: power ? { [power]: allowance } : {},
      orders: power ? { [power]: book } : {},
    }),
    [kind, pieces, legal, power, allowance, book],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (error) return { status: "error", error, retry };
  if (!board) return { status: "loading" };
  return {
    status: "ready",
    desk: { board, rulesReady: engine, kind, pieces, legal, allowance, book, ctx, sync, verdicts, syncError, setOrder, removeOrder, clearOrders, holdAll, waive, settle, judge, everyone, judgeAs },
  };
}
