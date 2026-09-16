import { useEffect, useRef } from "react";

export function HowToPlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="how" onClose={onClose} aria-labelledby="how-title">
      <header>
        <h2 id="how-title">How to play</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="how-body">
        <section>
          <h3>The goal</h3>
          <p>
            Seven great powers, 34 supply centres. Hold 18 after a Fall turn and you win outright. Otherwise the
            survivors agree a draw. There are no dice: every unit has the same strength, and a move succeeds only
            when it has more support than whatever stands against it.
          </p>
        </section>
        <section>
          <h3>Giving orders</h3>
          <table className="keys">
            <tbody>
              <tr>
                <th>Move</th>
                <td>Click a unit, then the province it should move to.</td>
              </tr>
              <tr>
                <th>Hold</th>
                <td>
                  Click the unit twice, or press <kbd>H</kbd>.
                </td>
              </tr>
              <tr>
                <th>Support</th>
                <td>
                  Click your unit, press <kbd>S</kbd>, click the unit you are helping, then its destination. Click that
                  unit a second time to support it holding.
                </td>
              </tr>
              <tr>
                <th>Convoy</th>
                <td>
                  Click a fleet at sea, press <kbd>C</kbd>, click the army, then where it lands.
                </td>
              </tr>
              <tr>
                <th>Retreat</th>
                <td>
                  Click the dislodged unit, then an empty neighbour. Press <kbd>D</kbd> to disband it.
                </td>
              </tr>
              <tr>
                <th>Build</th>
                <td>Click an empty home supply centre you still own. Click a unit to disband it.</td>
              </tr>
              <tr>
                <th>Cancel</th>
                <td>
                  <kbd>Esc</kbd>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="fine">
            Only legal orders are offered. Units without an order hold. On a phone, use the buttons under the map
            instead of the keys, and pinch to zoom.
          </p>
        </section>
        <section>
          <h3>How a turn resolves</h3>
          <ul>
            <li>All orders are revealed and resolved at the same time.</li>
            <li>Equal strength bounces. Nobody moves, and the province stays as it was.</li>
            <li>A support is cut when the supporting unit is attacked, unless the attack comes from the province it is supporting into.</li>
            <li>A dislodged unit must retreat to an empty neighbour or disband.</li>
            <li>After Fall, each power builds or disbands until its units match its supply centres.</li>
          </ul>
          <p className="fine">
            Adjudication follows the 2023 rulebook and passes all 171 Diplomacy Adjudicator Test Cases.
          </p>
        </section>
        <section>
          <h3>Receipts</h3>
          <p>
            After every phase, Cabal shows each order with the reason it succeeded or failed. In multiplayer games a
            message can carry a sealed pledge to specific orders, and when the phase resolves every pledge is stamped
            kept or broken for the table to see.
          </p>
        </section>
      </div>
    </dialog>
  );
}
