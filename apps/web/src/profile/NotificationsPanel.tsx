/**
 * Notifications: the device switch, the five kinds, and the offer made in a game. The browser's
 * permission prompt only ever follows a click on a button that says what it turns on.
 */
import type { NotificationKind, NotificationsResponse } from "@cabal/protocol";
import { useCallback, useEffect, useState } from "react";
import { failureText } from "../net/failure.js";
import { loadApi } from "../net/lazy.js";
import { readPlayer } from "../net/player.js";
import { type PushState, browserPushEnv, currentSubscription, dismissOffer, markPushOwner, offerDismissed, pushState, subscribedFor, turnOffPush, turnOnPush } from "../net/push.js";
import { usePlayer } from "./usePlayer.js";

const KINDS: { kind: NotificationKind; label: string; blurb: string }[] = [
  { kind: "deadline", label: "Orders due", blurb: "Before a deadline, when you have not readied." },
  { kind: "phase", label: "Phase resolved", blurb: "The results are in and the next phase is open." },
  { kind: "press", label: "Private press", blurb: "A dispatch for you alone. Never its text." },
  { kind: "started", label: "Game started", blurb: "A table you sit at has begun." },
  { kind: "finished", label: "Game over", blurb: "A game you played has ended." },
];

export function usePush() {
  const player = usePlayer();
  const [state, setState] = useState<PushState | "loading">("loading");
  const [settings, setSettings] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const playerId = player?.id ?? null;
  const refresh = useCallback(async () => {
    const env = browserPushEnv();
    const sub = env.hasServiceWorker && env.hasPushManager && env.permission === "granted" ? await currentSubscription() : null;
    // The browser's subscription counts only when this account registered it here.
    setState(pushState(env, subscribedFor(playerId, sub?.endpoint ?? null)));
  }, [playerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadSettings = useCallback(async () => {
    const me = readPlayer();
    if (!me) return;
    try {
      const { api } = await loadApi();
      setSettings(await api.notifications(me.secret));
    } catch (err) {
      setError(failureText(err));
    }
  }, []);

  const turnOn = useCallback(async (): Promise<boolean> => {
    const me = readPlayer();
    if (!me) return false;
    setBusy(true);
    setError(null);
    try {
      const { api } = await loadApi();
      const result = await turnOnPush({ publicKey: () => api.pushKey(), register: (sub) => api.subscribePush(me.secret, sub as Parameters<typeof api.subscribePush>[1]) });
      if (!result.ok) {
        if (result.why === "server-off") setError("Notifications are switched off on this server.");
        else if (result.why === "unavailable") setError(result.detail ? `This browser could not subscribe: ${result.detail}` : "This browser could not subscribe.");
        else if (result.why === "dismissed") setError("The browser's question was closed without an answer. Try again when you are ready.");
      } else {
        markPushOwner(me.id, result.endpoint);
        dismissOffer();
        void loadSettings();
      }
      await refresh();
      return result.ok;
    } catch (err) {
      setError(failureText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, loadSettings]);

  const turnOff = useCallback(async () => {
    const me = readPlayer();
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      const { api } = await loadApi();
      await turnOffPush((endpoint) => api.unsubscribePush(me.secret, endpoint));
      await refresh();
      void loadSettings();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, loadSettings]);

  const setKind = useCallback(async (kind: NotificationKind, on: boolean) => {
    const me = readPlayer();
    if (!me) return;
    setSettings((s) => (s ? { ...s, preferences: { ...s.preferences, [kind]: on } } : s));
    try {
      const { api } = await loadApi();
      const preferences = await api.setNotifications(me.secret, { [kind]: on });
      setSettings((s) => (s ? { ...s, preferences } : s));
    } catch (err) {
      setError(failureText(err));
      void loadSettings();
    }
  }, [loadSettings]);

  return { player, state, settings, error, busy, turnOn, turnOff, setKind, loadSettings };
}

function stateLine(state: PushState | "loading"): string {
  switch (state) {
    case "loading":
      return "Checking this browser.";
    case "unsupported":
      return "This browser cannot show notifications from Cabal.";
    case "needs-install":
      return "On iPhone and iPad, notifications reach Cabal only once it is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.";
    case "denied":
      return "Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.";
    case "off":
      return "This device is not told about your games. Turn notifications on and Cabal tells you when your orders are due or a phase resolves, while you are away from the table.";
    case "on":
      return "This device is told about your games while you are away from the table.";
  }
}

export function NotificationsPanel() {
  const push = usePush();
  const { loadSettings } = push;
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // The server dropped every device of this account (it signed out elsewhere, say): not on here.
  const state = push.state === "on" && push.settings?.devices === 0 ? "off" : push.state;
  return (
    <div className="notify-panel">
      <p>{stateLine(state)}</p>
      {state === "off" ? (
        <button type="button" className="btn brass" onClick={() => void push.turnOn()} disabled={push.busy}>
          {push.busy ? "Asking the browser" : "Turn on notifications on this device"}
        </button>
      ) : state === "on" ? (
        <button type="button" className="btn" onClick={() => void push.turnOff()} disabled={push.busy}>
          {push.busy ? "Turning off" : "Turn off on this device"}
        </button>
      ) : null}
      {push.settings ? (
        <fieldset className="notify-kinds">
          <legend>
            Tell me about
            {push.settings.devices > 0 ? (
              <span className="fine">
                {" "}
                (on {push.settings.devices} {push.settings.devices === 1 ? "device" : "devices"})
              </span>
            ) : null}
          </legend>
          {KINDS.map((k) => (
            <label key={k.kind} className="option toggle">
              <input type="checkbox" checked={push.settings!.preferences[k.kind]} onChange={(e) => void push.setKind(k.kind, e.target.checked)} />
              <span className="option-label">{k.label}</span>
              <span className="option-blurb">
                {k.kind === "deadline"
                  ? `${push.settings!.reminderMinutes} minutes before a deadline, when you have not readied. Not at quicker tables, where the phase has only just opened.`
                  : k.blurb}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {push.error ? (
        <p className="form-error" role="alert">
          {push.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The offer, made once a player has done something that makes notifications worth having (sat
 * down at a table, readied their orders). Shown only where it can work, only to a signed-in
 * player, never again once answered.
 */
export function NotifyOffer({ moment }: { moment: "seated" | "ready" }) {
  const push = usePush();
  const [hidden, setHidden] = useState(offerDismissed);
  const [done, setDone] = useState(false);
  // Only offer what this server can send.
  const [serverOn, setServerOn] = useState(false);
  useEffect(() => {
    if (hidden || !push.player) return;
    let live = true;
    loadApi()
      .then(({ api }) => api.pushKey())
      .then(
        (key) => live && setServerOn(key !== null),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [hidden, push.player]);
  if (done) {
    return (
      <p className="notify-offer done" role="status">
        Notifications are on for this device. Change them any time from your account.
      </p>
    );
  }
  if (!push.player || push.state !== "off" || hidden || !serverOn) return null;
  return (
    <aside className="notify-offer" aria-label="Notifications">
      <p>
        {moment === "ready"
          ? "Your orders are in. Want a nudge on this device when the phase resolves, or when the next deadline is near?"
          : "You have a seat. Want a nudge on this device when the game starts and when your orders are due?"}
      </p>
      <div className="seal-actions">
        <button
          type="button"
          className="btn brass small"
          disabled={push.busy}
          onClick={async () => {
            if (await push.turnOn()) setDone(true);
          }}
        >
          {push.busy ? "Asking the browser" : "Notify me"}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            dismissOffer();
            setHidden(true);
          }}
        >
          Not now
        </button>
      </div>
      {push.error ? (
        <p className="form-error" role="alert">
          {push.error}
        </p>
      ) : null}
    </aside>
  );
}
