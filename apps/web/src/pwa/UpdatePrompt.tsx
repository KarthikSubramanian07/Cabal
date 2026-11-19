/**
 * "A new version of Cabal is ready." A dispatch slip pinned to the foot of the screen, never a
 * modal: the player finishes what they are doing and reloads when it suits them.
 */
import { useSyncExternalStore } from "react";
import { type UpdateState, pageUpdater } from "./register.js";

const NONE: UpdateState = { waiting: false };
const noop = () => () => undefined;

export function UpdatePrompt() {
  const updater = pageUpdater();
  const state = useSyncExternalStore(updater?.subscribe ?? noop, updater?.get ?? (() => NONE), () => NONE);
  return (
    <div className="update-slot" role="status" aria-live="polite">
      {state.waiting && updater ? (
        <div className="update-slip">
          <p>A new version of Cabal is ready.</p>
          <div className="update-actions">
            <button type="button" className="btn brass" onClick={() => updater.apply()}>
              Reload
            </button>
            <button type="button" className="btn ghost" onClick={() => updater.dismiss()}>
              Later
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
