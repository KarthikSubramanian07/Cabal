/**
 * One table, live. Reads the public summary (so a wrong code is a clear "no such table" rather
 * than a socket that never answers) while it dials a socket, and holds the socket open: as a
 * spectator, or bound to this device's seat when it holds one. Whichever answers first draws the
 * table. Joining stores the new seat token and rebinds.
 */
import type { PledgeInput, PowerName, Recipient } from "@cabal/protocol";
import type { CabalSocket, ConnectionStatus, Frame } from "@cabal/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CabalError } from "@cabal/protocol/client";
import { ApiError, api, failureText, openSocket } from "../net/api.js";
import { readPlayer } from "../net/player.js";
import { type HeldSeat, forgetSeat, readSeat, saveName, saveSeat } from "../net/seats.js";
import { type RoomView, applyFrame, fromSummary, markThreadRead } from "./room.js";

export type RoomLoad = { kind: "loading" } | { kind: "missing" } | { kind: "unreachable"; message: string } | { kind: "ready"; view: RoomView };

export interface Room {
  load: RoomLoad;
  seat: HeldSeat | null;
  connection: ConnectionStatus;
  /** Something the player should know that is not an error in what they just did. */
  notice: string | null;
  /** Sit down as the signed-in player: at `power`, or any open seat. */
  join: (player: { id: string; handle: string; secret: string }, power?: PowerName) => Promise<void>;
  start: () => Promise<void>;
  say: (body: string) => Promise<void>;
  retry: () => void;
  /** Replace this seat's orders for the phase. Resolves with the server's verdict on each. */
  setOrders: (phase: string, orders: string[]) => Promise<Frame<"orders.ack">>;
  /** Say this seat is done (or not) with the phase. False when the socket is not open. */
  setReady: (phase: string, ready: boolean) => boolean;
  /** Send press, with a pledge when one is attached, quoting an earlier message of the thread by id. */
  send: (to: Recipient, body: string, pledge?: PledgeInput, quote?: string) => Promise<void>;
  /** Mark a thread read up to a message's `sentAt` (its newest, usually). */
  markRead: (thread: Recipient, upTo: number) => void;
  vote: (value: boolean, include?: PowerName[]) => boolean;
  extend: (phase: string) => Promise<Frame<"extend.ack">>;
  /** The server's clock as best this device knows it. */
  serverNow: () => number;
  /** Drop the connection and dial again now, without waiting for the backoff. */
  reconnect: () => void;
  /**
   * The server turned this seat's socket away because the seat is already open on too many
   * tabs and devices. The seat is still this device's: `reconnect` tries again.
   */
  crowded: boolean;
  /** True once the socket has delivered a welcome at least once this visit. */
  everOpen: boolean;
}

export function useRoom(code: string): Room {
  const [load, setLoad] = useState<RoomLoad>({ kind: "loading" });
  const [seat, setSeat] = useState<HeldSeat | null>(() => readSeat(code));
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [everOpen, setEverOpen] = useState(false);
  const [crowded, setCrowded] = useState(false);
  /** Bumped to dial a socket afresh after the server turned the last one away. */
  const [dial, setDial] = useState(0);
  const socket = useRef<CabalSocket | null>(null);
  /**
   * Tables this visit has already asked the server for a seat token. A claim happens at most
   * once per table per visit: a socket refused after a claim must never mint another token in a
   * loop, since every new token pushes the oldest of the seat's tokens (another device's) out.
   */
  const claimed = useRef(new Set<string>());

  // The summary: does this table exist, and what does it look like right now?
  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    api.summary(code).then(
      (summary) => {
        if (!live) return;
        setLoad((current) => (current.kind === "ready" ? current : { kind: "ready", view: fromSummary(summary, Date.now()) }));
      },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ kind: "missing" });
        else setLoad({ kind: "unreachable", message: failureText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [code, attempt]);

  const token = seat?.token;

  // A seat this player holds from another device: the account gets its own token for this one.
  const mine = load.kind === "ready" && !seat ? load.view.seats.find((s) => s.handle && s.handle.toLowerCase() === readPlayer()?.handle.toLowerCase()) : undefined;
  const claim = mine?.power;
  useEffect(() => {
    if (!claim || claimed.current.has(code)) return;
    const player = readPlayer();
    if (!player) return;
    claimed.current.add(code);
    let live = true;
    api.seatToken(code, player.secret).then(
      (res) => {
        if (!live) return;
        const held = { gameId: res.gameId, power: res.power, token: res.token, name: player.handle, userId: player.id };
        saveSeat(held);
        setSeat({ ...held, savedAt: Date.now() });
      },
      // Not this player's seat after all, or the server would not say: keep watching.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, claim]);

  // The socket, dialled alongside the summary rather than after it (on a slow line that is a
  // whole round trip sooner to the board), and hung up if the table turns out not to exist. A
  // new token (a seat just taken) rebinds it.
  const gone = load.kind === "missing" || load.kind === "unreachable";
  useEffect(() => {
    if (gone) return;
    const ws = openSocket(code, token);
    socket.current = ws;
    // `status` names two things on CabalSocket: the connection's state (a string) and the
    // server's game status frame (an object), which arrives when a game starts or pauses.
    const offStatus = ws.on("status", (status: unknown) => {
      if (typeof status === "string") {
        setConnection(status as ConnectionStatus);
        if (status === "open") setEverOpen(true);
      }
    });
    const offFrame = ws.on("frame", (frame) => {
      setLoad((current) => {
        const view = applyFrame(current.kind === "ready" ? current.view : null, frame, Date.now());
        return view && (current.kind !== "ready" || view !== current.view) ? { kind: "ready", view } : current;
      });
    });
    const offFatal = ws.on("fatal", (error) => {
      if (error.code === "too_many_sockets") {
        // The seat is still this device's; it is open in too many places at once. Keep it.
        setCrowded(true);
        setNotice("This seat is open in too many tabs and devices at once. Close one, then press Reconnect.");
        return;
      }
      // The seat this device remembered is no longer its own: say so, and keep watching. A seat
      // handed to a substitute is not claimed back.
      if (error.code === "seat_reassigned") claimed.current.add(code);
      forgetSeat(code);
      setSeat(null);
      setNotice(
        error.code === "seat_reassigned"
          ? "Your seat was given to a substitute after missed turns. You are watching now."
          : "This device's seat at this table is no longer valid. You are watching now.",
      );
    });
    void ws.start().catch(() => undefined);
    return () => {
      offStatus();
      offFrame();
      offFatal();
      ws.close();
      if (socket.current === ws) socket.current = null;
    };
  }, [code, token, gone, dial]);

  // The network is back: dial at once rather than wait out a grown backoff.
  useEffect(() => {
    const up = () => socket.current?.reconnect();
    window.addEventListener("online", up);
    return () => window.removeEventListener("online", up);
  }, []);

  const join = useCallback(
    async (player: { id: string; handle: string; secret: string }, power?: PowerName) => {
      const res = await api.joinGame(code, power ? { power } : {}, player.secret);
      const name = player.handle;
      const held = { gameId: res.gameId, power: res.power, token: res.token, name, userId: player.id };
      saveName(name);
      if (!saveSeat(held)) setNotice("This browser will not store your seat, so it lasts until you close this tab.");
      setSeat({ ...held, savedAt: Date.now() });
    },
    [code],
  );

  const start = useCallback(async () => {
    if (!seat) return;
    await api.startGame(code, seat.token);
  }, [code, seat]);

  const say = useCallback(async (body: string) => {
    const ws = socket.current;
    if (!ws) throw new Error("not connected");
    await ws.press("ALL", body);
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const live = () => {
    const ws = socket.current;
    if (!ws) throw new CabalError("not_connected", "the socket is not open");
    return ws;
  };

  const setOrders = useCallback((phase: string, orders: string[]) => live().setOrders(phase, orders), []);
  const setReady = useCallback((phase: string, ready: boolean) => socket.current?.ready(phase, ready) ?? false, []);
  const send = useCallback(async (to: Recipient, body: string, pledge?: PledgeInput, quote?: string) => {
    await live().press(to, body, pledge, quote);
  }, []);
  const markRead = useCallback((thread: Recipient, upTo: number) => {
    setLoad((current) => {
      if (current.kind !== "ready") return current;
      const view = markThreadRead(current.view, thread);
      return view === current.view ? current : { kind: "ready", view };
    });
    if (upTo > 0) socket.current?.markRead(thread, upTo);
  }, []);
  const vote = useCallback((value: boolean, include?: PowerName[]) => socket.current?.vote(value, include) ?? false, []);
  const extend = useCallback((phase: string) => live().extend(phase), []);
  const serverNow = useCallback(() => socket.current?.serverNow() ?? Date.now(), []);
  const reconnect = useCallback(() => {
    if (crowded) {
      setCrowded(false);
      setNotice(null);
      setDial((n) => n + 1);
      return;
    }
    socket.current?.reconnect();
  }, [crowded]);

  return { load, seat, connection, notice, join, start, say, retry, setOrders, setReady, send, markRead, vote, extend, serverNow, reconnect, everOpen, crowded };
}

/** Remember a seat this device was just dealt by creating a game. */
export function keepCreatedSeat(seat: Omit<HeldSeat, "savedAt">): boolean {
  saveName(seat.name);
  return saveSeat(seat);
}
