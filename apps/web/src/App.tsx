import { type CSSProperties, useMemo, useState } from "react";
import { POWERS } from "./engine.js";
import { POWER_VAR, WarRoomMap } from "./map/WarRoomMap.jsx";
import { mentions, unitOf } from "./map/orders.js";
import { useSandbox } from "./sandbox.js";

interface Picker {
  x: number;
  y: number;
  title: string;
  options: string[];
}

export function App() {
  const sb = useSandbox();
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);

  const phaseKind = sb?.phase.at(-1) ?? "M";
  const myUnits = useMemo(() => (sb ? Object.keys(sb.legal) : []), [sb]);

  const selectable = useMemo(() => {
    const s = new Set<string>();
    if (!sb) return s;
    if (!selectedUnit) {
      for (const u of myUnits) {
        const p = unitOf(u)?.region.split("/")[0];
        if (p) s.add(p);
      }
      return s;
    }
    for (const o of sb.legal[selectedUnit] ?? []) {
      for (const p of mentions(o).slice(1)) s.add(p);
    }
    const own = unitOf(selectedUnit)?.region.split("/")[0];
    if (own) s.add(own);
    return s;
  }, [sb, selectedUnit, myUnits]);

  if (!sb) {
    return (
      <div className="app">
        <Masthead phase="loading" />
        <div className="table">
          <div className="board" />
          <aside className="dossier">
            <section>
              <p className="hint">Loading the engine.</p>
            </section>
          </aside>
        </div>
      </div>
    );
  }

  const ordersForMap: { power: string; text: string; failed?: boolean }[] = Object.entries(sb.orders).flatMap(
    ([power, list]) => Object.values(list).map((text) => ({ power, text })),
  );
  if (sb.last && Object.keys(sb.orders).every((p) => Object.keys(sb.orders[p] ?? {}).length === 0)) {
    // between phases, show the last results on the map
    for (const r of sb.last.results) {
      if (r.order && !r.order.endsWith(" H")) ordersForMap.push({ power: r.power, text: r.order, failed: !r.ok });
    }
  }

  const onTap = (province: string, at: { x: number; y: number }) => {
    setPicker(null);
    if (phaseKind === "A") {
      const options = (sb.legal[""] ?? []).filter((o) => mentions(o).includes(province) || o === "WAIVE");
      if (options.length) setPicker({ x: at.x, y: at.y, title: province, options });
      return;
    }
    const unitHere = myUnits.find((u) => unitOf(u)?.region.split("/")[0] === province);
    if (!selectedUnit) {
      if (unitHere) setSelectedUnit(unitHere);
      return;
    }
    const options = sb.candidates(selectedUnit, province);
    if (options.length === 0) {
      if (unitHere) setSelectedUnit(unitHere);
      else setSelectedUnit(null);
      return;
    }
    // an empty province means "go there": apply the plain move when it is unambiguous,
    // otherwise (coasts, occupied provinces, supports) open the picker
    const occupied = Object.values(sb.state.units).some((list) =>
      list.some((u) => unitOf(u)?.region.split("/")[0] === province),
    );
    const moves = options.filter((o) => o.startsWith(`${selectedUnit} - ${province}`));
    if (!occupied && moves.length === 1) {
      sb.setOrder(sb.power, selectedUnit, moves[0]!);
      setSelectedUnit(null);
      return;
    }
    if (options.length === 1) {
      sb.setOrder(sb.power, selectedUnit, options[0]!);
      setSelectedUnit(null);
      return;
    }
    setPicker({ x: at.x, y: at.y, title: `${selectedUnit} at ${province}`, options });
  };

  const choose = (text: string) => {
    const key = phaseKind === "A" ? text : selectedUnit ?? text;
    sb.setOrder(sb.power, key, text);
    setPicker(null);
    setSelectedUnit(null);
  };

  const mine = sb.orders[sb.power] ?? {};
  const centers = (p: string) => sb.state.centers[p]?.length ?? 0;

  return (
    <div className="app">
      <Masthead phase={sb.phase} />
      <div className="table">
        <div className="board">
          <WarRoomMap
            map={sb.map}
            state={sb.state}
            orders={ordersForMap}
            selectable={selectable}
            selected={selectedUnit ? (unitOf(selectedUnit)?.region.split("/")[0] ?? null) : null}
            onTap={onTap}
          />
          {picker ? (
            <div className="picker" style={{ left: picker.x, top: picker.y - 8 }} role="menu">
              <div className="title">{picker.title}</div>
              {picker.options.map((o) => (
                <button key={o} type="button" onClick={() => choose(o)}>
                  {o}
                </button>
              ))}
              <button type="button" onClick={() => setPicker(null)} style={{ color: "var(--fg-faint)" }}>
                cancel
              </button>
            </div>
          ) : null}
        </div>
        <aside className="dossier">
          <section>
            <h2>
              Powers <small>tap to command</small>
            </h2>
            <div className="powers">
              {POWERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="power-chip"
                  aria-pressed={sb.power === p}
                  style={{ "--power": POWER_VAR[p] } as CSSProperties}
                  onClick={() => {
                    sb.setPower(p);
                    setSelectedUnit(null);
                    setPicker(null);
                  }}
                >
                  <span className="dot" />
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                  <span className="n">{centers(p)}</span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>
              Orders <small>{sb.phase}</small>
            </h2>
            {phaseKind === "A" ? (
              <p className="hint">
                Tap a home centre to build, or a unit to disband. Allowance:{" "}
                <b>{(sb.legal[""] ?? []).length ? "see options" : "none"}</b>
              </p>
            ) : (
              <p className="hint">
                {selectedUnit ? (
                  <>
                    <b>{selectedUnit}</b> selected. Tap a destination, a unit to support, or its own province to hold.
                  </>
                ) : (
                  <>Tap one of your units, then tap where it should go. Every option offered is legal.</>
                )}
              </p>
            )}
            <div className="ledger" aria-label="your orders">
              {Object.entries(mine).map(([key, text]) => (
                <div className="row pending" key={key}>
                  <span className="mark">•</span>
                  <span>{text}</span>
                  <button type="button" aria-label={`remove ${text}`} onClick={() => sb.clearOrder(sb.power, key)}>
                    ×
                  </button>
                </div>
              ))}
              {Object.keys(mine).length === 0 ? <div className="hint">No orders yet. Unordered units hold.</div> : null}
            </div>
          </section>
          <section>
            <div className="toolbar">
              <button type="button" className="btn primary" onClick={sb.resolve} disabled={sb.game.status() !== "active"}>
                Resolve {sb.phase}
              </button>
              <button type="button" className="btn" onClick={sb.reset}>
                New board
              </button>
              <span className="hint">{sb.game.status() === "active" ? "" : sb.game.status()}</span>
            </div>
          </section>
          {sb.last ? (
            <section>
              <h2>
                Receipts <small>{sb.last.phase}</small>
              </h2>
              <div className="ledger" aria-label="adjudication results">
                {sb.last.results
                  .filter((r) => !(r.code === "ok" && r.order.endsWith(" H")))
                  .map((r, i) => (
                    <div className={`row ${r.ok ? "ok" : "no"}`} key={i}>
                      <span className="mark">{r.ok ? "✓" : "✗"}</span>
                      <span>
                        {r.order}
                        <div className="reason">{r.reason}</div>
                      </span>
                      <span className="reason">{r.power.slice(0, 3)}</span>
                    </div>
                  ))}
                {sb.last.dislodged.map((d) => (
                  <div className="row no" key={d.unit}>
                    <span className="mark">↯</span>
                    <span>
                      {d.unit} dislodged from {d.attacker_from}
                      <div className="reason">retreats: {d.retreat_options.join(", ") || "none, must disband"}</div>
                    </span>
                    <span />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
      <footer className="footer">
        <span>Cabal: Diplomacy with receipts.</span>
        <span>Rules engine in Rust, adjudicating in your browser.</span>
        <span>DATC v3.0: 171 of 171.</span>
      </footer>
    </div>
  );
}

function Masthead({ phase }: { phase: string }) {
  return (
    <header className="masthead">
      <div className="wordmark">
        Cab<em>al</em>
      </div>
      <div className="tagline">Diplomacy with receipts.</div>
      <div className="spacer" />
      <div className="phase-chip">{phase}</div>
    </header>
  );
}
