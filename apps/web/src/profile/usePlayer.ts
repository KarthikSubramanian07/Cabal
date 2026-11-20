/**
 * The signed-in guest on this device, and what they can do with their account. The account is
 * made the first time a person plays (see IdentityProvider), not when they arrive: browsing the
 * front door, the sandbox or a profile never creates one.
 */
import type { DeleteMeResponse, MeResponse, RecoveryCodeResponse } from "@cabal/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { isApiFailure } from "../net/failure.js";
import { loadApi, localRefusal } from "../net/lazy.js";
import { type StoredPlayer, forgetPlayer, readPlayer, renameStoredPlayer, savePlayer, subscribePlayer, tidyRecoveryCode } from "../net/player.js";
import { turnOffPush } from "../net/push.js";
import { forgetSeatsOf } from "../net/seats.js";

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
export async function leaveDevice(account: StoredPlayer): Promise<void> {
  try {
    const { api } = await loadApi();
    await turnOffPush((endpoint) => api.unsubscribePush(account.secret, endpoint)).catch(() => undefined);
    await api.logout(account.secret).catch(() => undefined);
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
    return readPlayer() ?? { ...stored, savedAt: Date.now() };
  }, []);

  const recover = useCallback(async (code: string): Promise<StoredPlayer> => {
    const { api } = await loadApi();
    const before = readPlayer();
    const session = await api.recoverPlayer(tidyRecoveryCode(code));
    savePlayer({ id: session.player.id, handle: session.player.handle, secret: session.secret });
    await replaced(before, session.player);
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
    const stored = { id: session.player.id, handle: session.player.handle, secret: session.secret };
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
      return await api.unlinkGoogle(current.secret);
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
   * End this device's session. The account stays; a recovery code brings it back. Its seats and
   * notifications on this device go with it.
   */
  const signOut = useCallback(async (): Promise<void> => {
    const current = readPlayer();
    if (!current) return;
    // Signed out here whatever the server said; a secret it no longer knows is harmless.
    await leaveDevice(current);
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
