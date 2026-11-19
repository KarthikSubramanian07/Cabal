/**
 * The account card: the handle and how to change it, the recovery code that carries the account
 * to another device, notifications, and signing this device out. One dialog with every section
 * on it, opened at the one the player asked for.
 */
import type { MeResponse, RecoveryCodeResponse } from "@cabal/protocol";
import { type FormEvent, Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import { Link } from "../app/router.jsx";
import { recoveryFile } from "../net/player.js";
import { accountFailure, handleProblem } from "./handles.js";
import { useAccount } from "./usePlayer.js";

const NotificationsPanel = lazy(() => import("./NotificationsPanel.jsx").then((m) => ({ default: m.NotificationsPanel })));

export type AccountSection = "handle" | "recovery" | "notifications" | "device";

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function RenameForm({ me, onRenamed }: { me: MeResponse; onRenamed: (me: MeResponse) => void }) {
  const { rename } = useAccount();
  const [handle, setHandle] = useState(me.player.handle);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const sayId = useId();
  const waitUntil = me.account.renameAvailableAt;
  const locked = waitUntil !== null && waitUntil > Date.now();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (handle.trim() === me.player.handle) {
      setSaid({ ok: false, text: "That is already your handle." });
      return;
    }
    const problem = handleProblem(handle);
    if (problem) {
      setSaid({ ok: false, text: problem });
      input.current?.focus();
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      const next = await rename(handle.trim());
      onRenamed(next);
      setSaid({ ok: true, text: `You are ${next.player.handle} now. Your record and the Ledger follow the new name.` });
    } catch (err) {
      setSaid({ ok: false, text: accountFailure(err) });
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-row" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="rename-input">Handle</label>
        <input
          ref={input}
          id="rename-input"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20}
          value={handle}
          disabled={locked}
          onChange={(e) => setHandle(e.target.value)}
          aria-describedby={`${noteId}${said ? ` ${sayId}` : ""}`}
          aria-invalid={said !== null && !said.ok}
        />
        <p className="field-note" id={noteId}>
          {locked ? `You changed it recently. You can change it again on ${day(waitUntil!)}.` : "You can change it once every 14 days. The old name stays reserved for you for a while."}
        </p>
      </div>
      <button type="submit" className="btn" disabled={busy || locked}>
        {busy ? "Renaming" : "Rename"}
      </button>
      {said ? (
        <p className={said.ok ? "account-said" : "form-error"} id={sayId} role={said.ok ? "status" : "alert"}>
          {said.text}
        </p>
      ) : null}
    </form>
  );
}

function RecoverySection({ me, onIssued }: { me: MeResponse; onIssued: () => void }) {
  const { issueRecoveryCode } = useAccount();
  const [code, setCode] = useState<RecoveryCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const issued = me.account.recoveryIssuedAt;

  // A code just made is the thing to read: move to it once it is drawn.
  useEffect(() => {
    if (code) box.current?.focus();
  }, [code]);

  // The file link holds the code; let it go when the dialog closes.
  useEffect(() => () => void (href && URL.revokeObjectURL(href)), [href]);

  async function issue() {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const fresh = await issueRecoveryCode();
      setCode(fresh);
      setHref(URL.createObjectURL(new Blob([recoveryFile(me.player.handle, fresh.recoveryCode, fresh.issuedAt, window.location.origin)], { type: "text/plain" })));
      onIssued();
    } catch (err) {
      setError(accountFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.recoveryCode);
      setSaid("Copied. Paste it somewhere only you can read.");
    } catch {
      setSaid("This browser would not copy it. Select the code and copy it by hand, or save the file.");
    }
  }

  return (
    <div className="account-recovery">
      {code ? (
        <>
          <div className="recovery-slip" ref={box} tabIndex={-1} role="group" aria-label="Your recovery code">
            <span className="recovery-stamp" aria-hidden="true">
              Shown once
            </span>
            <code className="recovery-code">{code.recoveryCode}</code>
          </div>
          <div className="seal-actions">
            <button type="button" className="btn brass" onClick={copy}>
              Copy the code
            </button>
            {href ? (
              <a className="btn" href={href} download={`cabal-recovery-${me.player.handle}.txt`}>
                Save it as a file
              </a>
            ) : null}
          </div>
          <p className="field-note">Anyone with this code can play as you. It will not be shown again; any older code has stopped working.</p>
        </>
      ) : (
        <>
          <p>
            {issued
              ? `You made a recovery code on ${day(issued)}. If you have lost it, make a new one: the old one stops working.`
              : "Your account lives in this browser. Make a recovery code and keep it safe: it is the only way to use this account on another device, or to get it back if this browser's data is cleared."}
          </p>
          <button type="button" className={issued ? "btn" : "btn brass"} onClick={issue} disabled={busy}>
            {busy ? "Making a code" : issued ? "Make a new recovery code" : "Make a recovery code"}
          </button>
        </>
      )}
      {said ? (
        <p className="account-said" role="status">
          {said}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DeviceSection({ me, onSignedOut }: { me: MeResponse; onSignedOut: () => void }) {
  const { signOut } = useAccount();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const unsafe = me.account.recoveryIssuedAt === null;
  return (
    <div className="account-device">
      <p>
        {me.account.sessions === 1 ? "This is the only device signed in to your account." : `${me.account.sessions} devices are signed in to your account.`} Signing out here ends this
        device's session only. Your seats leave this device with you, and return when you sign in here again; this device stops being told about your games.
      </p>
      {sure ? (
        <div className="account-confirm" role="group" aria-label="Confirm signing out">
          <p className={unsafe ? "form-error" : undefined}>
            {unsafe
              ? "You have no recovery code. Once you sign out, nobody can get this account back. Make a code first, unless you mean to leave it."
              : "You can sign back in with your recovery code."}
          </p>
          <div className="seal-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await signOut();
                setBusy(false);
                onSignedOut();
              }}
            >
              {busy ? "Signing out" : "Sign out of this device"}
            </button>
            <button type="button" className="btn" onClick={() => setSure(false)}>
              Stay signed in
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setSure(true)}>
          Sign out of this device
        </button>
      )}
    </div>
  );
}

export function AccountDialog({ open, section, onClose }: { open: boolean; section: AccountSection; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { me, player } = useAccount();
  const [account, setAccount] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    me().then(
      (m) => live && setAccount(m),
      (err: unknown) => live && setError(accountFailure(err)),
    );
    return () => {
      live = false;
    };
  }, [open, tick, me]);

  // Open at the section that was asked for: once per opening. The account is read again after a
  // rename or a new recovery code, and that must not pull focus away from what the player is doing.
  const placed = useRef(false);
  useEffect(() => {
    placed.current = false;
  }, [open, section]);
  useEffect(() => {
    if (!open || !account || placed.current) return;
    placed.current = true;
    const el = ref.current?.querySelector<HTMLElement>(`#account-${section}`);
    el?.scrollIntoView({ block: "nearest" });
    el?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), a")?.focus();
  }, [open, account, section]);

  // Signed out (here or in another tab) while the card is open: nothing left to show.
  useEffect(() => {
    if (open && !player) onClose();
  }, [open, player, onClose]);

  return (
    <dialog ref={ref} className="how account" onClose={onClose} aria-labelledby={titleId}>
      <header>
        <h2 id={titleId}>Your account</h2>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="how-body">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : !account ? (
          <p className="room-wait" role="status">
            Reading your file
          </p>
        ) : (
          <>
            <section id="account-handle" aria-labelledby="account-handle-title">
              <h3 id="account-handle-title">Name</h3>
              <RenameForm me={account} onRenamed={setAccount} />
              <p className="fine account-record">
                <Link href={`/u/${encodeURIComponent(account.player.handle)}`} onClick={onClose}>
                  See your public record
                </Link>
              </p>
            </section>
            <section id="account-recovery" aria-labelledby="account-recovery-title">
              <h3 id="account-recovery-title">Recovery code</h3>
              <RecoverySection me={account} onIssued={() => setTick((n) => n + 1)} />
            </section>
            <section id="account-notifications" aria-labelledby="account-notifications-title">
              <h3 id="account-notifications-title">Notifications</h3>
              <Suspense fallback={<p className="fine">Reading your notification settings</p>}>
                <NotificationsPanel />
              </Suspense>
            </section>
            <section id="account-device" aria-labelledby="account-device-title">
              <h3 id="account-device-title">This device</h3>
              <DeviceSection me={account} onSignedOut={onClose} />
            </section>
          </>
        )}
      </div>
    </dialog>
  );
}
