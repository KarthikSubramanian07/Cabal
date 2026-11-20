/**
 * The account this device is signed in to, and what the player can do with it. Signing in with
 * Google is the main way in: it opens the same account on every device. A guest account (a
 * handle and nothing else) is the quick way to play without one, and lives in this browser.
 * Nobody is asked to sign in until they play: browsing the front door, the sandbox or a profile
 * never makes an account.
 */
import type { DeleteMeResponse, MeResponse, RecoveryCodeResponse } from "@cabal/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { isApiFailure } from "../net/failure.js";
import { loadApi, localRefusal } from "../net/lazy.js";
import { type StoredPlayer, forgetPlayer, markGoogle, readPlayer, renameStoredPlayer, savePlayer, subscribePlayer, tidyRecoveryCode } from "../net/player.js";
import { turnOffPush } from "../net/push.js";
import { forgetSeatsOf } from "../net/seats.js";
import { settleBeforeSignOut } from "../net/sync.js";

export function usePlayer(): StoredPlayer | null {
  return useSyncExternalStore(subscribePlayer, readPlayer, () => null);
}

/** The server no longer knows this device's secret: sign the device out rather than act as nobody. */
function signedOutIfRefused(error: unknown): never {
  if (isApiFailure(error) && error.status === 401) forgetPlayer();
  throw error;
}

/**
 * Let go of an account on this device: stop this browser's notifications for it, end its session
 * with the server, and forget the seats it took here, so the next person at the device can neither
 * play as it nor be told about its games. Best effort: a server that cannot be reached still leaves
 * the device clean.
 */
export async function leaveDevice(account: StoredPlayer, everywhere = false): Promise<void> {
  await settleBeforeSignOut(account).catch(() => undefined);
  try {
    const { api } = await loadApi();
    await turnOffPush((endpoint) => api.unsubscribePush(account.secret, endpoint)).catch(() => undefined);
    await api.logout(account.secret, everywhere).catch(() => undefined);
  } catch {
    // The client did not load: nothing reached the server, but the device is still cleared.
  }
  forgetSeatsOf(account);
}

/** Another account is now this device's: the one it replaced lets go of the device. */
async function replaced(before: StoredPlayer | null, after: { id: string }): Promise<void> {
  if (before && before.id !== after.id) await leaveDevice(before);
}

export function useAccount() {
  const player = usePlayer();

  /** Make a guest account. Without a handle the server picks one. */
  const create = useCallback(async (handle?: string): Promise<StoredPlayer> => {
    const { api } = await loadApi();
    const before = readPlayer();
    const session = await api.createPlayer(handle);
    const stored = { id: session.player.id, handle: session.player.handle, secret: session.secret };
    savePlayer(stored);
    await replaced(before, stored);
    return readPlayer() ?? { ...stored, google: false, savedAt: Date.now() };
  }, []);

  const recover = useCallback(async (code: string): Promise<StoredPlayer> => {
    const { api } = await loadApi();
    const before = readPlayer();
    const session = await api.recoverPlayer(tidyRecoveryCode(code));
    savePlayer({ id: session.player.id, handle: session.player.handle, secret: session.secret });
    await replaced(before, session.player);
    // The code may open an account that also signs in with Google: ask, so the menu says so.
    await api.me(session.secret).then((m) => markGoogle(m.account.google === true)).catch(() => undefined);
    return readPlayer()!;
  }, []);

  /**
   * Sign in with the ID token Google's button handed the page. A device already signed in links
   * its account to the Google account (or, when that Google account opens another account, moves
   * to that one). Its old session ends either way: the device holds the new one.
   */
  const googleSignIn = useCallback(async (credential: string): Promise<StoredPlayer & { outcome: "signed_in" | "linked" | "created" }> => {
    const { api } = await loadApi();
    const before = readPlayer();
    const session = await api.googleSignIn(credential, before?.secret);
    const stored = { id: session.player.id, handle: session.player.handle, secret: session.secret, google: true };
    savePlayer(stored);
    if (before && before.id === stored.id && before.secret !== stored.secret) await api.logout(before.secret).catch(() => undefined);
    await replaced(before, stored);
    return { ...(readPlayer() ?? { ...stored, savedAt: Date.now() }), outcome: session.outcome };
  }, []);

  /** Unlink the Google account. The recovery code, if one was made, still works. */
  const unlinkGoogle = useCallback(async (): Promise<MeResponse> => {
    const current = readPlayer();
    if (!current) throw localRefusal(401, "not signed in");
    try {
      const { api } = await loadApi();
      const res = await api.unlinkGoogle(current.secret);
      markGoogle(false);
      return res;
    } catch (error) {
      return signedOutIfRefused(error);
    }
  }, []);

  const me = useCallback(async (): Promise<MeResponse> => {
    const current = readPlayer();
    if (!current) throw localRefusal(401, "not signed in");
    try {
      const { api } = await loadApi();
      const res = await api.me(current.secret);
      if (res.player.handle !== current.handle) renameStoredPlayer(res.player.handle);
      markGoogle(res.account.google === true);
      return res;
    } catch (error) {
      return signedOutIfRefused(error);
    }
  }, []);

  const rename = useCallback(async (handle: string): Promise<MeResponse> => {
    const current = readPlayer();
    if (!current) throw localRefusal(401, "not signed in");
    try {
      const { api } = await loadApi();
      const res = await api.rename(current.secret, handle);
      renameStoredPlayer(res.player.handle);
      return res;
    } catch (error) {
      return signedOutIfRefused(error);
    }
  }, []);

  const issueRecoveryCode = useCallback(async (): Promise<RecoveryCodeResponse> => {
    const current = readPlayer();
    if (!current) throw localRefusal(401, "not signed in");
    try {
      const { api } = await loadApi();
      return await api.issueRecoveryCode(current.secret);
    } catch (error) {
      return signedOutIfRefused(error);
    }
  }, []);

  /**
   * Sign out: end this device's session, or with `everywhere` every device's. The account stays:
   * Google (or a recovery code) signs back in. Its seats, sandbox copy and notifications on this
   * device go with it.
   */
  const signOut = useCallback(async (everywhere = false): Promise<void> => {
    const current = readPlayer();
    if (!current) return;
    // Signed out here whatever the server said; a secret it no longer knows is harmless.
    await leaveDevice(current, everywhere);
    forgetPlayer();
  }, []);

  /**
   * Delete the account for good: the server forgets it and turns its seats into ghosts. This device
   * then lets go of everything the account left here, at once: its push subscription (the server's
   * copy is already gone), its seats and its secret. A dead secret must not outlive the answer,
   * whatever the player does next (reload, leave, close the tab). `deleted` hears the answer just
   * before the secret goes, in the same tick, so a card can keep its farewell on screen.
   */
  const deleteAccount = useCallback(async (handle: string, deleted?: (result: DeleteMeResponse) => void): Promise<DeleteMeResponse> => {
    const current = readPlayer();
    if (!current) throw localRefusal(401, "not signed in");
    let result: DeleteMeResponse;
    try {
      const { api } = await loadApi();
      result = await api.deleteAccount(current.secret, handle);
    } catch (error) {
      return signedOutIfRefused(error);
    }
    forgetSeatsOf(current);
    deleted?.(result);
    if (readPlayer()?.id === current.id) forgetPlayer();
    // A profile is cached publicly for half a minute: refetch it past this browser's cache, so the
    // deleted record is not what this device shows next (the server now answers 404).
    if (typeof fetch === "function") void fetch(`/api/players/${encodeURIComponent(current.handle)}`, { cache: "reload" }).catch(() => undefined);
    await turnOffPush(async () => undefined).catch(() => undefined);
    return result;
  }, []);

  return { player, create, recover, googleSignIn, unlinkGoogle, me, rename, issueRecoveryCode, signOut, deleteAccount };
}
