/**
 * One table, live. Reads the public summary first (so a wrong code is a clear "no such table"
 * rather than a socket that never answers), then holds a socket open: as a spectator, or bound
 * to this device's seat when it holds one. Joining stores the new seat token and rebinds.
 */
import type { PowerName } from "@cabal/protocol";
import type { CabalSocket, ConnectionStatus } from "@cabal/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, failureText, openSocket } from "../net/api.js";
import { type HeldSeat, forgetSeat, readSeat, saveName, saveSeat } from "../net/seats.js";
import { type RoomView, applyFrame, fromSummary } from "./room.js";

export type RoomLoad = { kind: "loading" } | { kind: "missing" } | { kind: "unreachable"; message: string } | { kind: "ready"; view: RoomView };

export interface Room {
  load: RoomLoad;
  seat: HeldSeat | null;
  connection: ConnectionStatus;
  /** Something the player should know that is not an error in what they just did. */
  notice: string | null;
  join: (name: string, power?: PowerName) => Promise<void>;
  start: () => Promise<void>;
  say: (body: string) => Promise<void>;
  retry: () => void;
}

export function useRoom(code: string): Room {
  const [load, setLoad] = useState<RoomLoad>({ kind: "loading" });
  const [seat, setSeat] = useState<HeldSeat | null>(() => readSeat(code));
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<CabalSocket | null>(null);

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

  const ready = load.kind === "ready";
  const token = seat?.token;

  // The socket, once the table is known to exist. A new token (a seat just taken) rebinds it.
  useEffect(() => {
    if (!ready) return;
    const ws = openSocket(code, token);
    socket.current = ws;
    const offStatus = ws.on("status", (status) => setConnection(status));
    const offFrame = ws.on("frame", (frame) => {
      setLoad((current) => {
        const view = applyFrame(current.kind === "ready" ? current.view : null, frame, Date.now());
        return view && (current.kind !== "ready" || view !== current.view) ? { kind: "ready", view } : current;
      });
    });
    const offFatal = ws.on("fatal", (error) => {
      // The seat this device remembered is no longer its own: say so, and keep watching.
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
  }, [code, token, ready]);

  const join = useCallback(
    async (name: string, power?: PowerName) => {
      const res = await api.joinGame(code, { name, ...(power ? { power } : {}) });
      const held = { gameId: res.gameId, power: res.power, token: res.token, name };
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

  return { load, seat, connection, notice, join, start, say, retry };
}

/** Remember a seat this device was just dealt by creating a game. */
export function keepCreatedSeat(seat: Omit<HeldSeat, "savedAt">): boolean {
  saveName(seat.name);
  return saveSeat(seat);
}
