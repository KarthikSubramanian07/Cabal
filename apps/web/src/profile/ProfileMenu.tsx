/**
 * The player's seal in the top bar. Signed out, it is a Sign in button: with Google where the
 * deployment has it (one account on every device), otherwise a menu offering a guest handle or a
 * recovery code. Signed in, it is the player's menu: their games, record, account and Sign out.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Link, usePathname } from "../app/router.jsx";
import { useGoogleSignInOn } from "./GoogleButton.jsx";
import { useIdentity } from "./Identity.jsx";
import { useAccount } from "./usePlayer.js";

/** A small square wax seal with the handle's first letter, as the player's mark. */
export function PlayerSeal({ handle, size = 26 }: { handle: string; size?: number }) {
  return (
    <svg className="player-seal" viewBox="0 0 26 26" width={size} height={size} aria-hidden="true">
      <path d="M13 1.5l3 2.2 3.7-.4 1.5 3.4 3.4 1.5-.4 3.7 2.2 3-2.2 3 .4 3.7-3.4 1.5-1.5 3.4-3.7-.4-3 2.2-3-2.2-3.7.4-1.5-3.4-3.4-1.5.4-3.7L1.5 13l2.2-3-.4-3.7 3.4-1.5 1.5-3.4 3.7.4z" />
      <text x="13" y="17.4" textAnchor="middle">
        {handle.slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

export function ProfileMenu() {
  const { player, ensurePlayer, openAccount, openRestore } = useIdentity();
  const { signOut } = useAccount();
  const googleOn = useGoogleSignInOn();
  const [leaving, setLeaving] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const path = usePathname();

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  /** An account that signs in with Google signs out in one go: Google brings it back on any device. */
  const signOutNow = async () => {
    setOpen(false);
    setLeaving(true);
    await signOut();
    setLeaving(false);
    button.current?.focus();
  };

  return (
    <div className="player-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`player-button${player ? "" : " signin-button"}`}
        aria-expanded={player || !googleOn ? open : undefined}
        aria-controls={player || !googleOn ? listId : undefined}
        disabled={leaving}
        onClick={() => {
          // Signed out with Google on, the button is the way in: no menu, straight to signing in.
          if (!player && googleOn) return void ensurePlayer();
          setOpen((o) => !o);
        }}
      >
        {player ? <PlayerSeal handle={player.handle} /> : <span className="player-seal empty" aria-hidden="true" />}
        {/* The name is the visible text (WCAG 2.5.3); on a phone it is read out but not shown. */}
        <span className="player-name">{player ? <><span className="sr-only">Your account, </span>{player.handle}</> : leaving ? "Signing out" : "Sign in"}</span>
      </button>
      <div className="player-list" id={listId} hidden={!open}>
        {player ? (
          <>
            <p className="player-head">
              Signed in as <strong>{player.handle}</strong>
              <span className="player-kind">{player.google ? "With Google, on every device" : "Guest account, in this browser only"}</span>
            </p>
            {!player.google && googleOn ? (
              <button type="button" className="player-keep" onClick={act(() => openAccount("google"))}>
                Sign in with Google to keep it
              </button>
            ) : null}
            <Link href="/games">Your games</Link>
            <Link href={`/u/${encodeURIComponent(player.handle)}`}>Your record</Link>
            <button type="button" onClick={act(() => openAccount("handle"))}>
              Rename
            </button>
            <button type="button" onClick={act(() => openAccount("notifications"))}>
              Notifications
            </button>
            {player.google ? null : (
              <>
                <button type="button" onClick={act(() => openAccount("recovery"))}>
                  Recovery code
                </button>
                <button type="button" onClick={act(openRestore)}>
                  Restore another account
                </button>
              </>
            )}
            {player.google ? (
              <button type="button" onClick={() => void signOutNow()}>
                Sign out
              </button>
            ) : (
              // A guest account may have no way back: the account card says so before it goes.
              <button type="button" onClick={act(() => openAccount("device"))}>
                Sign out
              </button>
            )}
          </>
        ) : (
          <>
            <p className="player-head">Nobody is signed in here. A handle is all it takes: no email, no password.</p>
            <button type="button" onClick={act(() => void ensurePlayer())}>
              Choose a handle
            </button>
            <button type="button" onClick={act(openRestore)}>
              Restore an account
            </button>
          </>
        )}
      </div>
    </div>
  );
}
