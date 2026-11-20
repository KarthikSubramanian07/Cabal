/**
 * Who is playing on this device. Nobody is asked for anything until they play: the first time
 * a person sits down (Play now, a new table, a seat at someone else's), `ensurePlayer` opens the
 * handle dialog, makes a guest account and resolves with it. After that it resolves at once.
 *
 * The account dialog (rename, recovery code, notifications, sign out) and the restore dialog are
 * mounted here too, so the player menu and any page can open them.
 */
import { GoogleButton, useGoogleSignInOn } from "./GoogleButton.jsx";
import { type FormEvent, type ReactNode, Suspense, createContext, lazy, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SyncedPrefs } from "@cabal/protocol";
import { setShortcuts } from "../app/prefs.js";
import { failureCode } from "../net/failure.js";
import { onRemotePrefs, startSync } from "../net/sync.js";
import { type StoredPlayer, forgetPlayer, readPlayer } from "../net/player.js";
import type { AccountSection } from "./AccountDialog.jsx";
import { accountFailure, handleProblem } from "./handles.js";
import { useAccount } from "./usePlayer.js";

export interface Identity {
  player: StoredPlayer | null;
  /**
   * The player on this device, making one first if there is none. `reason` is the line the
   * handle dialog opens with. Resolves with null when the person closes the dialog.
   */
  ensurePlayer: (reason?: string) => Promise<StoredPlayer | null>;
  /**
   * Do something as the player on this device (sit down, set a table), making one first if there
   * is none. When the server no longer knows this device's secret (signed out elsewhere, or the
   * account was removed) the device lets go of it, asks again, and tries once more. Resolves with
   * null when the person closes the dialog.
   */
  asPlayer: <T>(reason: string, work: (player: StoredPlayer) => Promise<T>) => Promise<T | null>;
  /** Open the account dialog, at one of its sections. */
  openAccount: (section?: AccountSection) => void;
  /** Open the dialog that restores an account from its recovery code. */
  openRestore: () => void;
}

const AccountDialog = lazy(() => import("./AccountDialog.jsx").then((m) => ({ default: m.AccountDialog })));

const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentity outside IdentityProvider");
  return value;
}


/**
 * Where the dialog is. `choose` is the front door: Sign in with Google where the deployment has
 * it, otherwise the handle form. `guest` is the handle form reached from it, `welcome` names a
 * new Google account, and `restore` takes a recovery code.
 */
type Mode = "choose" | "guest" | "restore" | "welcome";

/**
 * The account a restore would replace on this device, and whether a recovery code could bring it
 * back. `safe` is null while the server is being asked.
 */
interface Replacing {
  handle: string;
  safe: boolean | null;
}

function HandleDialog({
  open,
  reason,
  startIn,
  onDone,
  onMakeCode,
}: {
  open: boolean;
  /** Why the player is being asked: what they were about to do. Empty when they chose to sign in. */
  reason: string;
  startIn: Mode;
  onDone: (player: StoredPlayer | null) => void;
  /** Leave this dialog for the account card's recovery code, to keep the account on this device. */
  onMakeCode: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const errorId = useId();
  const noteId = useId();
  const [mode, setMode] = useState<Mode>(startIn);
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<Replacing | null>(null);
  const [leave, setLeave] = useState(false);
  /** A Google account just made: the player it opened, until they keep or change its handle. */
  const [made, setMade] = useState<StoredPlayer | null>(null);
  const leaveRef = useRef<HTMLInputElement>(null);
  const warnId = useId();
  const { create, recover, googleSignIn, me, rename } = useAccount();
  const googleOn = useGoogleSignInOn();
  /** The front door shows Google; without it, the handle form is the front door. */
  const signIn = mode === "choose" && googleOn;
  const handleForm = mode === "guest" || mode === "welcome" || (mode === "choose" && !googleOn);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setMode(startIn);
      setError(null);
      setBusy(false);
      setLeave(false);
      setMade(null);
      setHandle("");
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open, startIn]);

  // Restoring while signed in replaces the account on this device. Find out, before anything is
  // pressed, whether that account could be brought back.
  useEffect(() => {
    if (!open) return;
    const current = readPlayer();
    if (!current) {
      setReplacing(null);
      return;
    }
    let live = true;
    setReplacing({ handle: current.handle, safe: current.google ? true : null });
    me().then(
      (m) => live && setReplacing({ handle: m.player.handle, safe: m.account.google === true || m.account.recoveryIssuedAt !== null }),
      // The server no longer knows it (the device was signed out), or could not say: warn.
      () => live && setReplacing(readPlayer() ? { handle: current.handle, safe: false } : null),
    );
    return () => {
      live = false;
    };
  }, [open, me]);

  /** Replacing an account nobody could restore needs the player to say so first. */
  function mayReplace(): boolean {
    if (!replacing || replacing.safe === true || leave) return true;
    setError(`Tick the box to leave ${replacing.handle} behind, or make a recovery code for it first.`);
    leaveRef.current?.focus();
    return false;
  }

  useEffect(() => {
    if (!open) return;
    if (handleForm) input.current?.focus();
    else if (mode === "restore") codeInput.current?.focus();
  }, [open, mode, handleForm]);

  async function run(work: () => Promise<StoredPlayer | null>) {
    setBusy(true);
    setError(null);
    try {
      const done = await work();
      if (done) onDone(done);
    } catch (err) {
      setError(accountFailure(err));
      if (handleForm) input.current?.focus();
      else if (mode === "restore") codeInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  /** Google answered: a new account is named first; an existing one is signed straight in. */
  function withGoogle(credential: string) {
    void run(async () => {
      const done = await googleSignIn(credential);
      if (done.outcome !== "created") return done;
      setMade(done);
      setHandle(done.handle);
      setMode("welcome");
      return null;
    });
  }

  function take(e: FormEvent) {
    e.preventDefault();
    const problem = handleProblem(handle);
    if (problem) {
      setError(problem);
      input.current?.focus();
      return;
    }
    if (mode === "welcome" && made) {
      if (handle.trim().toLowerCase() === made.handle.toLowerCase()) return onDone(readPlayer() ?? made);
      void run(async () => {
        await rename(handle.trim());
        return readPlayer() ?? made;
      });
      return;
    }
    if (!mayReplace()) return;
    void run(() => create(handle.trim()));
  }

  function restore(e: FormEvent) {
    e.preventDefault();
    if (code.replace(/[\s-]/g, "").length < 16) {
      setError("Paste the whole code. It starts with CABAL and has five groups of four.");
      codeInput.current?.focus();
      return;
    }
    if (!mayReplace()) return;
    void run(() => recover(code));
  }

  const warning = replacing ? (
    <div className={`replace-note${replacing.safe === false ? " unsafe" : ""}`} id={warnId}>
      {replacing.safe === false ? (
        <>
          <p>
            You are signed in as <strong>{replacing.handle}</strong>, a guest account with no recovery code. Restoring another account here signs {replacing.handle} out of this
            device, and nobody can get it back, nor the seats it holds.
          </p>
          <div className="replace-actions">
            <button type="button" className="btn small" onClick={onMakeCode}>
              Make a recovery code first
            </button>
            <label className="replace-leave">
              <input ref={leaveRef} type="checkbox" checked={leave} onChange={(e) => setLeave(e.target.checked)} />
              <span>Leave {replacing.handle} behind for good</span>
            </label>
          </div>
        </>
      ) : (
        <p>
          You are signed in as <strong>{replacing.handle}</strong>. Restoring another account signs {replacing.handle} out of this device
          {replacing.safe ? "; you can sign back in to it later." : "."}
        </p>
      )}
    </div>
  ) : null;

  const title =
    mode === "restore" ? "Restore your account" : mode === "welcome" ? "Welcome to Cabal" : mode === "guest" ? "Play as a guest" : googleOn ? "Sign in to Cabal" : "Choose your handle";

  const errorLine = error ? (
    <p className="form-error" id={errorId} role="alert">
      {error}
    </p>
  ) : null;

  return (
    <dialog ref={ref} className={`how seal-dialog${signIn ? " signin-dialog" : ""}`} onClose={() => onDone(made ? readPlayer() : null)} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon" onClick={() => onDone(made ? readPlayer() : null)} aria-label="Close">
          ×
        </button>
      </header>
      {signIn ? (
        <div className="seal-form signin">
          <p className="seal-lede">
            {reason ? `${reason} ` : ""}Sign in once, and your games, seats, rating and settings follow you to every device.
          </p>
          {/* Drawn only while the dialog is open, so Google's script loads when it is wanted. */}
          {open ? <GoogleButton className="seal-google" onCredential={withGoogle} /> : null}
          {busy ? (
            <p className="field-note" role="status">
              Signing you in
            </p>
          ) : null}
          {errorLine}
          <p className="signin-privacy">Cabal keeps no email address, name or photo from Google: only a sealed mark that it is you.</p>
          <p className="seal-or" aria-hidden="true">
            <span>or</span>
          </p>
          <div className="signin-guest">
            <button type="button" className="btn" disabled={busy} onClick={() => setMode("guest")}>
              Play as a guest
            </button>
            <p className="field-note">Just a handle, kept in this browser. Sign in with Google later to keep it everywhere.</p>
          </div>
          <p className="seal-fine">
            <button type="button" className="linkish" onClick={() => setMode("restore")}>
              Have a recovery code from a guest account? Use it here.
            </button>
          </p>
        </div>
      ) : handleForm ? (
        <form className="seal-form" onSubmit={take} noValidate>
          <p className="seal-lede">
            {mode === "welcome" && made ? (
              <>
                You are signed in. We named you <strong>{made.handle}</strong>; keep it, or choose your own. The table, the Ledger and your record know you by it.
              </>
            ) : (
              <>
                {reason ? `${reason} ` : ""}The table, the Ledger and your record will know you by this name.
              </>
            )}
          </p>
          {mode !== "welcome" ? warning : null}
          <div className="field">
            <label htmlFor="handle-input">Handle</label>
            <input
              ref={input}
              id="handle-input"
              name="handle"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={20}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={`${noteId}${error ? ` ${errorId}` : ""}`}
            />
            <p className="field-note" id={noteId}>
              3 to 20 letters, digits, _ or -, starting with a letter. You can change it every 14 days.
            </p>
          </div>
          {errorLine}
          <div className="seal-actions">
            <button type="submit" className="btn brass" disabled={busy}>
              {busy ? "Writing it in" : "Take this handle"}
            </button>
            {mode === "welcome" && made ? (
              <button type="button" className="btn" disabled={busy} onClick={() => onDone(readPlayer() ?? made)}>
                Keep {made.handle}
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void run(() => create())}>
                Pick one for me
              </button>
            )}
          </div>
          {mode === "welcome" ? null : (
            <p className="seal-fine">
              {googleOn ? (
                <>
                  A guest account lives in this browser only. Sign in with Google from the player menu at any time to keep it on every device.{" "}
                  <button type="button" className="linkish" onClick={() => setMode("choose")}>
                    Sign in with Google instead.
                  </button>
                </>
              ) : (
                <>
                  No email and no password: the account lives in this browser. Save its recovery code from the player menu to play on another device.{" "}
                  <button type="button" className="linkish" onClick={() => setMode("restore")}>
                    Played here before on another device? Restore your account.
                  </button>
                </>
              )}
            </p>
          )}
        </form>
      ) : (
        <form className="seal-form" onSubmit={restore} noValidate>
          <p className="seal-lede">Enter the recovery code you saved. This device signs in as you; your other devices stay signed in.</p>
          {warning}
          <div className="field">
            <label htmlFor="recovery-input">Recovery code</label>
            <textarea
              ref={codeInput}
              id="recovery-input"
              name="code"
              rows={2}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="CABAL-XXXX-XXXX-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          {errorLine}
          <div className="seal-actions">
            <button type="submit" className="btn brass" disabled={busy}>
              {busy ? "Checking the code" : "Restore my account"}
            </button>
            {replacing ? (
              // A new account would replace this one too: that is signing out, from the account card.
              <button type="button" className="btn" disabled={busy} onClick={() => onDone(null)}>
                Keep playing as {replacing.handle}
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => setMode("choose")}>
                {googleOn ? "Back to sign in" : "Choose a new handle instead"}
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}

const DEFAULT_REASON = "";
const EXPIRED_REASON = "This device is no longer signed in to its account.";

/** Settings arriving from the player's other device, applied here. */
function applyRemotePrefs(prefs: SyncedPrefs): void {
  if (prefs.shortcuts !== undefined) setShortcuts(prefs.shortcuts);
  // The sound deck is loaded only where sound is played; bring it in to switch it.
  if (prefs.sound !== undefined) void import("../sound/deck.js").then(({ deck }) => deck.enabled() !== prefs.sound && deck.setEnabled(prefs.sound!, true));
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const { player } = useAccount();
  // Keep the signed-in account's settings and sandbox game level with its other devices.
  useEffect(() => {
    onRemotePrefs(applyRemotePrefs);
    startSync();
  }, []);
  const [ask, setAsk] = useState<{ reason: string; mode: Mode; resolve: (p: StoredPlayer | null) => void } | null>(null);
  const [account, setAccount] = useState<AccountSection | null>(null);
  const pending = useRef<((p: StoredPlayer | null) => void)[]>([]);

  const ensurePlayer = useCallback((reason = DEFAULT_REASON) => {
    const current = readPlayer();
    if (current) return Promise.resolve(current);
    return new Promise<StoredPlayer | null>((resolve) => {
      pending.current.push(resolve);
      setAsk((open) => open ?? { reason, mode: "choose", resolve });
    });
  }, []);

  const asPlayer = useCallback(
    async <T,>(reason: string, work: (player: StoredPlayer) => Promise<T>): Promise<T | null> => {
      const me = await ensurePlayer(reason);
      if (!me) return null;
      try {
        return await work(me);
      } catch (error) {
        if (failureCode(error) !== "signed_out") throw error;
        // A dead secret: keep it and every later try fails the same way. Let it go and ask again.
        forgetPlayer();
        const again = await ensurePlayer(EXPIRED_REASON);
        return again ? await work(again) : null;
      }
    },
    [ensurePlayer],
  );

  const openRestore = useCallback(() => {
    setAsk({ reason: DEFAULT_REASON, mode: "restore", resolve: () => undefined });
  }, []);

  const done = useCallback((p: StoredPlayer | null) => {
    setAsk(null);
    for (const resolve of pending.current.splice(0)) resolve(p);
  }, []);

  const closeAccount = useCallback(() => setAccount(null), []);
  const value = useMemo<Identity>(
    () => ({ player, ensurePlayer, asPlayer, openAccount: (section = "handle") => setAccount(section), openRestore }),
    [player, ensurePlayer, asPlayer, openRestore],
  );

  return (
    <IdentityContext.Provider value={value}>
      {children}
      <HandleDialog
        open={ask !== null}
        reason={ask?.reason ?? DEFAULT_REASON}
        startIn={ask?.mode ?? "choose"}
        onDone={done}
        onMakeCode={() => {
          done(null);
          setAccount("recovery");
        }}
      />
      {account !== null ? (
        <Suspense fallback={null}>
          <AccountDialog open section={account} onClose={closeAccount} />
        </Suspense>
      ) : null}
    </IdentityContext.Provider>
  );
}
