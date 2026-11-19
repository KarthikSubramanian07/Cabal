/**
 * The signed-in guest on this device, and what they can do with their account. The account is
 * made the first time a person plays (see IdentityProvider), not when they arrive: browsing the
 * front door, the sandbox or a profile never creates one.
 */
import type { MeResponse, RecoveryCodeResponse } from "@cabal/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { isApiFailure } from "../net/failure.js";
import { loadApi, localRefusal } from "../net/lazy.js";
import { type StoredPlayer, forgetPlayer, readPlayer, renameStoredPlayer, savePlayer, subscribePlayer, tidyRecoveryCode } from "../net/player.js";

export function usePlayer(): StoredPlayer | null {
  return useSyncExternalStore(subscribePlayer, readPlayer, () => null);
}

/** The server no longer knows this device's secret: sign the device out rather than act as nobody. */
function signedOutIfRefused(error: unknown): never {
  if (isApiFailure(error) && error.status === 401) forgetPlayer();
  throw error;
}

export function useAccount() {
  const player = usePlayer();

  /** Make a guest account. Without a handle the server picks one. */
  const create = useCallback(async (handle?: string): Promise<StoredPlayer> => {
    const { api } = await loadApi();
    const session = await api.createPlayer(handle);
    const stored = { id: session.player.id, handle: session.player.handle, secret: session.secret };
    savePlayer(stored);
    return readPlayer() ?? { ...stored, savedAt: Date.now() };
  }, []);

  const recover = useCallback(async (code: string): Promise<StoredPlayer> => {
    const { api } = await loadApi();
    const session = await api.recoverPlayer(tidyRecoveryCode(code));
    savePlayer({ id: session.player.id, handle: session.player.handle, secret: session.secret });
    return readPlayer()!;
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

  /** End this device's session. The account stays; a recovery code brings it back. */
  const signOut = useCallback(async (): Promise<void> => {
    const current = readPlayer();
    if (!current) return;
    try {
      const { api } = await loadApi();
      await api.logout(current.secret);
    } catch {
      // Signed out here whatever the server said; a secret it no longer knows is harmless.
    }
    forgetPlayer();
  }, []);

  return { player, create, recover, me, rename, issueRecoveryCode, signOut };
}
