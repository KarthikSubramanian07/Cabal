/**
 * Sandbox: a local game driven entirely by the in-browser engine.
 * Orders are picked from the engine's legal list, so nothing illegal can be composed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Game, type MapInfo, type PhaseOutcome, type State, engineReady, mapInfo } from "./engine.js";
import { mentions, unitOf } from "./map/orders.js";

export interface Sandbox {
  map: MapInfo;
  game: Game;
  phase: string;
  state: State;
  power: string;
  setPower: (p: string) => void;
  /** Orders per power, keyed by unit text (or order text for builds). */
  orders: Record<string, Record<string, string>>;
  legal: Record<string, string[]>;
  setOrder: (power: string, key: string, text: string) => void;
  clearOrder: (power: string, key: string) => void;
  resolve: () => void;
  reset: () => void;
  last: PhaseOutcome | null;
  history: PhaseOutcome[];
  /** Candidates for a tapped province given the selected unit. */
  candidates: (unit: string, province: string) => string[];
}

export function useSandbox(): Sandbox | null {
  const [loaded, setLoaded] = useState(false);
  const [game, setGame] = useState<Game | null>(null);
  const [tick, setTick] = useState(0);
  const [power, setPower] = useState("FRANCE");
  const [orders, setOrders] = useState<Record<string, Record<string, string>>>({});
  const [history, setHistory] = useState<PhaseOutcome[]>([]);

  useEffect(() => {
    let cancelled = false;
    engineReady().then(() => {
      if (cancelled) return;
      setGame(new Game());
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const map = useMemo(() => (loaded ? mapInfo() : null), [loaded]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => (game ? game.state() : null), [game, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const legalRaw = useMemo(() => (game ? game.legal(power) : null), [game, power, tick]);

  const setOrder = useCallback((p: string, key: string, text: string) => {
    setOrders((o) => ({ ...o, [p]: { ...o[p], [key]: text } }));
  }, []);
  const clearOrder = useCallback((p: string, key: string) => {
    setOrders((o) => {
      const next = { ...o[p] };
      delete next[key];
      return { ...o, [p]: next };
    });
  }, []);

  const resolve = useCallback(() => {
    if (!game) return;
    const byPower: Record<string, string[]> = {};
    for (const [p, list] of Object.entries(orders)) byPower[p] = Object.values(list);
    const outcome = game.process({ orders: byPower });
    setHistory((h) => [...h, outcome]);
    setOrders({});
    setTick((t) => t + 1);
  }, [game, orders]);

  const reset = useCallback(() => {
    setGame(new Game());
    setOrders({});
    setHistory([]);
    setTick((t) => t + 1);
  }, []);

  const candidates = useCallback(
    (unit: string, province: string): string[] => {
      const list = legalRaw?.by_unit[unit] ?? [];
      const me = unitOf(unit)?.region.split("/")[0];
      return list.filter((o) => {
        const m = mentions(o);
        // the tapped province must appear beyond the unit's own province
        return m.slice(1).includes(province) || (province === me && /\sH$/.test(o));
      });
    },
    [legalRaw],
  );

  if (!loaded || !game || !map || !state || !legalRaw) return null;
  return {
    map,
    game,
    phase: game.phase(),
    state,
    power,
    setPower,
    orders,
    legal: legalRaw.by_unit,
    setOrder,
    clearOrder,
    resolve,
    reset,
    last: history.at(-1) ?? null,
    history,
    candidates,
  };
}
