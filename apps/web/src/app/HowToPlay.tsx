import { useEffect, useRef } from "react";
import { ADJUDICATION_CASES, CABAL_CASES, DATC_CASES } from "./adjudication.js";

export function HowToPlay({
  open,
  onClose,
  shortcuts,
  onShortcuts,
}: {
  open: boolean;
  onClose: () => void;
  /** Whether the single-key shortcuts (M, S, C, V, H, D, N, / and Space) are on. */
  shortcuts: boolean;
  onShortcuts: (on: boolean) => void;
}) {
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
                  Click the unit twice, or choose Hold
                  <span className="keys-only">
                    {" "}
                    (<kbd>H</kbd>)
                  </span>
                  .
                </td>
              </tr>
              <tr>
                <th>Support</th>
                <td>
                  Click your unit, choose Support
                  <span className="keys-only">
                    {" "}
                    (<kbd>S</kbd>)
                  </span>
                  , click the unit you are helping, then its destination. Click that unit a second time to support
                  it holding.
                </td>
              </tr>
              <tr>
                <th>Convoy</th>
                <td>
                  Click a fleet at sea, choose Convoy
                  <span className="keys-only">
                    {" "}
                    (<kbd>C</kbd>)
                  </span>
                  , click the army, then where it lands.
                </td>
              </tr>
              <tr>
                <th>By convoy</th>
                <td>
                  To send an army by sea, click it and choose By convoy
                  <span className="keys-only">
                    {" "}
                    (<kbd>V</kbd>)
                  </span>{" "}
                  before its destination; only the coasts a fleet can reach are lit. Then pick the fleets that carry
                  it from the list under the map. An order already written can be switched with its By convoy
                  button.
                </td>
              </tr>
              <tr>
                <th>Retreat</th>
                <td>
                  Click the dislodged unit, then an empty neighbour. Choose Disband
                  <span className="keys-only">
                    {" "}
                    (<kbd>D</kbd>)
                  </span>{" "}
                  to give it up.
                </td>
              </tr>
              <tr>
                <th>Build</th>
                <td>Click an empty home supply centre you still own. Click a unit to disband it.</td>
              </tr>
              <tr>
                <th>Cancel</th>
                <td>
                  Choose Cancel
                  <span className="keys-only">
                    {" "}
                    (<kbd>Esc</kbd>)
                  </span>{" "}
                  to drop an order half written.
                </td>
              </tr>
            </tbody>
          </table>
          <p className="fine">
            Only legal orders are offered. Units without an order hold. The Move, Support, Convoy, By convoy and Hold buttons
            are under the map. On a touch screen, pinch to zoom and drag to move the map. Your game is saved on this
            device as you play.
          </p>
          <p className="fine">
            You can also write orders in MILA under the orders list (Write an order
            <span className="keys-only">
              , or press <kbd>/</kbd>
            </span>
            ): <code>A PAR - BUR</code>, <code>F BRE S A PAR - PIC</code>, <code>F NTH C A LON - NWY</code>. Legal
            orders are suggested as you type, words like supports and arrows like -&gt; are understood, and several
            orders can go in at once separated by semicolons.
          </p>
          <p className="fine">
            Without a mouse, use the choices under the map: pick a unit, then where it goes. The same orders are
            offered there as on the map, and the board is also listed as text under Board as text.
          </p>
          <label className="setting">
            <input type="checkbox" checked={shortcuts} onChange={(e) => onShortcuts(e.target.checked)} />
            Single-key shortcuts (<kbd>M</kbd> <kbd>S</kbd> <kbd>C</kbd> <kbd>V</kbd> <kbd>H</kbd> <kbd>D</kbd> <kbd>N</kbd> <kbd>/</kbd> <kbd>Space</kbd>). Turn them off if
            you use speech input or they get in your way.
          </label>
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
            Adjudication follows the 2023 rulebook and passes all {ADJUDICATION_CASES} adjudication test cases: the {DATC_CASES} Diplomacy
            Adjudicator Test Cases and {CABAL_CASES} of Cabal&apos;s own.
          </p>
        </section>
        <section>
          <h3>Receipts</h3>
          <p>
            After every phase, Cabal shows each order with the reason it succeeded or failed. In multiplayer games a
            message can carry a sealed pledge to specific orders, and when the phase resolves every pledge is stamped
            kept or broken for the table to see.
          </p>
          <p>
            Every resolved phase is kept. Step through them with the arrows above the orders, drag the scrubber, or
            choose Replay
            <span className="keys-only">
              {" "}
              (<kbd>Space</kbd>)
            </span>{" "}
            to watch the whole game play back, each phase inked in turn, at half, normal or double speed.
          </p>
          <p className="fine">
            Each phase plays out on the board as it resolves. Choose Skip over the map
            <span className="keys-only">
              {" "}
              (<kbd>Esc</kbd>)
            </span>{" "}
            to land every piece and stamp at once.
          </p>
        </section>
        <section>
          <h3>Playing at a table</h3>
          <p>
            In a game with other people you order only your own power. Your orders are filed with the server as you
            write them and nobody else sees them. When you are done, press Ready: any unit you left without an order
            holds, and the phase resolves as soon as every seat is ready or the clock runs out.
          </p>
          <p>
            A Seal is a promise about your own orders, sent with a message. Sealed, the other player sees only the wax
            until the phase resolves; then the server stamps it kept or broken and their device opens the seal itself to
            check the orders are the ones you sealed. The server reads the orders when you send them, so a seal protects
            you from other players, not from the server. Every seal ends up in the Ledger.
          </p>
          <p>
            News from out of sight (a message for a thread you are not reading, a seal stamped, a phase resolved) is
            pinned at the edge of the room as a slip. Choose Read it, See the seal or See the results to go there
            <span className="keys-only">
              , or press <kbd>N</kbd> to reach the newest slip and again for the one before it
            </span>
            . A slip leaves on its own after a while, but never while you are on it, and what it said stays in the room.
          </p>
          <p>
            A draw ends the game when every player at the table votes for it in the same phase. Seats played by the bot
            have no vote and always share the draw.
          </p>
        </section>
      </div>
    </dialog>
  );
}
