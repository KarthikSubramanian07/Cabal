/**
 * The "why did this fail" panel: one result laid out like an umpire's ledger. A plain sentence
 * first, then the strengths on each side as tally strokes and numbers, the supports with who
 * cut them, the convoy and what broke it, and the note for a paradox. Opened inline under its
 * receipt, never as a dialog, so the board beside it stays in view and picks out the units.
 */
import type { Why } from "./explain.js";

/** A strength as tally strokes (a gate of five), with the number for anyone not counting strokes. */
export function Tally({ n }: { n: number }) {
  const strokes = Math.max(0, Math.min(n, 12));
  const w = strokes * 4 + Math.floor(strokes / 5) * 3 + 2;
  return (
    <span className="tally">
      <svg viewBox={`0 0 ${Math.max(w, 6)} 12`} width={Math.max(w, 6)} height="12" aria-hidden="true">
        {Array.from({ length: strokes }, (_, i) => {
          const gate = Math.floor(i / 5);
          if (i % 5 === 4) {
            const x0 = gate * 23 + 1;
            return <line key={i} x1={x0 - 1} y1={9.5} x2={x0 + 16} y2={2.5} />;
          }
          const x = gate * 23 + (i % 5) * 4 + 2;
          return <line key={i} x1={x} y1={1.5} x2={x} y2={10.5} />;
        })}
      </svg>
      <span className="tally-n">{n}</span>
    </span>
  );
}

export function WhyPanel({ why, id }: { why: Why; id: string }) {
  const { contest, defence } = why;
  return (
    <div className="why-panel" id={id} role="region" aria-label={`Why ${why.order} ${why.ok ? "succeeded" : "failed"}`}>
      <p className="why-sentence">
        <span className={`why-stamp${why.ok ? " ok" : ""}`}>{why.verdict}</span> {why.sentence}
      </p>

      {contest ? (
        <table className="why-ledger">
          <caption className="sr-only">Strengths</caption>
          <tbody>
            <tr className="mine">
              <th scope="row">{contest.mine.role}</th>
              <td>
                <code>{contest.mine.unit}</code>
              </td>
              <td>
                <Tally n={contest.mine.strength} />
              </td>
            </tr>
            {contest.against.length === 0 ? (
              <tr>
                <th scope="row">Against it</th>
                <td colSpan={2}>nobody</td>
              </tr>
            ) : (
              contest.against.map((s, i) => (
                <tr key={`${s.unit}-${i}`} className="theirs">
                  <th scope="row">{s.role}</th>
                  <td>
                    <code>{s.unit ?? "empty"}</code>
                  </td>
                  <td>
                    <Tally n={s.strength} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      ) : null}

      {defence && !contest ? (
        <table className="why-ledger">
          <caption className="sr-only">Strengths</caption>
          <tbody>
            <tr className="mine">
              <th scope="row">Holding</th>
              <td>
                <code>{why.unit}</code>
              </td>
              <td>
                <Tally n={defence.hold} />
              </td>
            </tr>
            {defence.attacks.map((a) => (
              <tr key={a.unit} className="theirs">
                <th scope="row">{a.succeeded ? "Beaten by" : "Attacked by"}</th>
                <td>
                  <code>{a.unit}</code>
                </td>
                <td>
                  <Tally n={a.strength} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {why.supports.length ? (
        <ul className="why-list" aria-label="Supports">
          {why.supports.map((s) => (
            <li key={s.unit} className={s.counted ? "counted" : "lost"}>
              <span className="glyph" aria-hidden="true">
                {s.counted ? "+1" : "✕"}
              </span>
              Support from <code>{s.unit}</code>{" "}
              {s.counted
                ? "counted."
                : s.cutBy.length
                  ? (
                      <>
                        was cut by <code>{s.cutBy.join(", ")}</code>.
                      </>
                    )
                  : s.code === "dislodged"
                    ? "was lost: the supporter was dislodged."
                    : "did not count."}
            </li>
          ))}
        </ul>
      ) : null}

      {why.cutBy.length ? (
        <p className="why-note">
          Cut by the attack from <code>{why.cutBy.join(", ")}</code>: a support is cut when the supporting unit is attacked
          from anywhere but the province it is supporting into.
        </p>
      ) : null}

      {why.convoys.length ? (
        <ul className="why-list" aria-label="Convoy">
          {why.convoys.map((c) => (
            <li key={c.unit} className={c.code === "ok" ? "counted" : "lost"}>
              <span className="glyph" aria-hidden="true">
                {c.code === "ok" ? "~" : "✕"}
              </span>
              <code>{c.unit}</code>{" "}
              {c.code === "ok"
                ? "carried the army."
                : c.dislodgedBy
                  ? (
                      <>
                        was dislodged by <code>{c.dislodgedBy}</code>, which broke the chain.
                      </>
                    )
                  : c.code === "paradox"
                    ? "was caught in a paradox."
                    : "did not carry it."}
            </li>
          ))}
          {why.convoyPath === false ? <li className="lost plain">No unbroken chain of fleets reached the far shore.</li> : null}
        </ul>
      ) : null}

      {why.cycle ? (
        <div className="why-cycle">
          <p>{why.cycle.note}</p>
          <ol>
            {why.cycle.orders.map((o) => (
              <li key={o}>
                <code>{o}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
