/**
 * Who is playing on this device. Nobody is asked for anything until they play: the first time
 * a person sits down (Play now, a new table, a seat at someone else's), `ensurePlayer` opens the
 * handle dialog, makes a guest account and resolves with it. After that it resolves at once.
 *
 * The account dialog (rename, recovery code, notifications, sign out) and the restore dialog are
 * mounted here too, so the player menu and any page can open them.
 */
import { type FormEvent, type ReactNode, Suspense, createContext, lazy, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { type StoredPlayer, readPlayer } from "../net/player.js";
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


type Mode = "choose" | "restore";

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
  const leaveRef = useRef<HTMLInputElement>(null);
  const warnId = useId();
  const { create, recover, me } = useAccount();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setMode(startIn);
      setError(null);
      setBusy(false);
      setLeave(false);
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
    setReplacing({ handle: current.handle, safe: null });
    me().then(
      (m) => live && setReplacing({ handle: m.player.handle, safe: m.account.recoveryIssuedAt !== null }),
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
    (mode === "choose" ? input.current : codeInput.current)?.focus();
  }, [open, mode]);

  async function run(work: () => Promise<StoredPlayer>) {
    setBusy(true);
    setError(null);
    try {
      onDone(await work());
    } catch (err) {
      setError(accountFailure(err));
      (mode === "choose" ? input.current : codeInput.current)?.focus();
    } finally {
      setBusy(false);
    }
  }

  function take(e: FormEvent) {
    e.preventDefault();
    const problem = handleProblem(handle);
    if (problem) {
      setError(problem);
      input.current?.focus();
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
            You are signed in as <strong>{replacing.handle}</strong>, and that account has no recovery code. Restoring another account here signs {replacing.handle} out of this
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
          {replacing.safe ? "; its recovery code brings it back." : "."}
        </p>
      )}
    </div>
  ) : null;

  return (
    <dialog ref={ref} className="how seal-dialog" onClose={() => onDone(null)} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>{mode === "choose" ? "Choose your handle" : "Restore your account"}</h2>
        <button type="button" className="icon" onClick={() => onDone(null)} aria-label="Close">
          ×
        </button>
      </header>
      {mode === "choose" ? (
        <form className="seal-form" onSubmit={take} noValidate>
          <p className="seal-lede">{reason}</p>
          {warning}
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
              3 to 20 letters, digits, _ or -, starting with a letter. It goes on your record and the Ledger; you can change it every 14 days.
            </p>
          </div>
          {error ? (
            <p className="form-error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
          <div className="seal-actions">
            <button type="submit" className="btn brass" disabled={busy}>
              {busy ? "Writing it in" : "Take this handle"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => create())}>
              Pick one for me
            </button>
          </div>
          <p className="seal-fine">
            No email and no password: the account lives in this browser. Save its recovery code from the player menu to play on another device.{" "}
            <button type="button" className="linkish" onClick={() => setMode("restore")}>
              Played here before on another device? Restore your account.
            </button>
          </p>
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
          {error ? (
            <p className="form-error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
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
                Choose a new handle instead
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}

const DEFAULT_REASON = "The table, the Ledger and your record will know you by this name.";

export function IdentityProvider({ children }: { children: ReactNode }) {
  const { player } = useAccount();
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

  const openRestore = useCallback(() => {
    setAsk({ reason: DEFAULT_REASON, mode: "restore", resolve: () => undefined });
  }, []);

  const done = useCallback((p: StoredPlayer | null) => {
    setAsk(null);
    for (const resolve of pending.current.splice(0)) resolve(p);
  }, []);

  const closeAccount = useCallback(() => setAccount(null), []);
  const value = useMemo<Identity>(
    () => ({ player, ensurePlayer, openAccount: (section = "handle") => setAccount(section), openRestore }),
    [player, ensurePlayer, openRestore],
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
