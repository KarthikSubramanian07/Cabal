/**
 * What follows a signed-in player between devices: their settings (shortcuts, sound) and their
 * sandbox game. The account keeps one copy of each with the time it was written, and the latest
 * write wins: a device sends what changed here, and takes what is newer there.
 *
 * - Settings go up a moment after they change, and come down when a device signs in or opens.
 * - The sandbox game goes up a few seconds after each change (and when the tab is hidden), and
 *   comes down when the sandbox opens. Starting a new game clears it everywhere.
 *
 * Signed out, nothing here talks to the server. Every call is best effort: a device offline keeps
 * playing on its own copy, and sends it the next time it can.
 */
import type { SyncResponse, SyncedPrefs } from "@cabal/protocol";
import { loadApi } from "./lazy.js";
import { type StoredPlayer, readPlayer, subscribePlayer } from "./player.js";

const PREFS_AT_KEY = "cabal.prefs.at";
const SHORTCUTS_KEY = "cabal.shortcuts";
const SOUND_KEY = "cabal.sound";
const SANDBOX_KEY = "cabal.sandbox";

/** How long a burst of sandbox changes settles before it goes up. */
const SANDBOX_SETTLE_MS = 6000;
const PREFS_SETTLE_MS = 800;
/** How long the sandbox waits for the account's copy before opening on this device's. */
export const SANDBOX_PULL_WAIT_MS = 1800;

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function get(key: string): string | null {
  try {
    return local()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  try {
    local()?.setItem(key, value);
  } catch {
    // storage refused: the setting still holds for this visit
  }
}

/** The settings as this device has them, and when they last changed here (0: never). */
export function localPrefs(): { value: SyncedPrefs; at: number } {
  return {
    value: { shortcuts: get(SHORTCUTS_KEY) !== "off", sound: get(SOUND_KEY) === "on" },
    at: Number(get(PREFS_AT_KEY) ?? "0") || 0,
  };
}

/** The saved time inside a sandbox autosave, or 0 when there is none to read. */
export function savedAtOf(body: string | null): number {
  if (!body) return 0;
  try {
    const at = (JSON.parse(body) as { savedAt?: unknown }).savedAt;
    return typeof at === "number" ? at : 0;
  } catch {
    return 0;
  }
}

/** Who applies settings that arrive from another device; set by the app shell so this module stays light. */
let applyPrefs: ((prefs: SyncedPrefs) => void) | null = null;

export function onRemotePrefs(apply: (prefs: SyncedPrefs) => void): void {
  applyPrefs = apply;
}

async function push(player: StoredPlayer, update: Parameters<Awaited<ReturnType<typeof loadApi>>["api"]["pushSync"]>[1]): Promise<SyncResponse | null> {
  try {
    const { api } = await loadApi();
    return await api.pushSync(player.secret, update);
  } catch {
    return null;
  }
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;

/** A setting changed on this device: note when, and send it up if the player is signed in. */
export function notePrefsChanged(now = Date.now()): void {
  set(PREFS_AT_KEY, String(now));
  if (!readPlayer()) return;
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    prefsTimer = null;
    const player = readPlayer();
    if (!player) return;
    const mine = localPrefs();
    void push(player, { prefs: { at: mine.at, value: mine.value } });
  }, PREFS_SETTLE_MS);
}

let sandboxTimer: ReturnType<typeof setTimeout> | null = null;
let sandboxPending: string | null = null;
/** The game the account is known to hold, less its save time: an autosave of the same game is not sent again. */
let accountGame: string | null = null;

/** A sandbox autosave without its save time, to tell a changed game from the same one saved again. */
export function gameOf(body: string | null): string | null {
  if (!body) return null;
  try {
    const { savedAt: _at, ...rest } = JSON.parse(body) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

function flushSandbox(): void {
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = null;
  const body = sandboxPending;
  sandboxPending = null;
  const player = readPlayer();
  if (!body || !player) return;
  const savedAt = savedAtOf(body);
  if (savedAt > 0) {
    accountGame = gameOf(body);
    void push(player, { sandbox: { savedAt, body } });
  }
}

/** The sandbox autosaved here (`body` is what it wrote): send it up once the changes settle. */
export function noteSandboxSaved(body: string): void {
  if (!readPlayer()) return;
  if (gameOf(body) === accountGame) {
    // The same game saved again (the sandbox opening on it): nothing new to send.
    sandboxPending = null;
    if (sandboxTimer) clearTimeout(sandboxTimer);
    sandboxTimer = null;
    return;
  }
  sandboxPending = body;
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = setTimeout(flushSandbox, SANDBOX_SETTLE_MS);
}

/** The player started a new sandbox game: the old one goes from the account too. */
export function noteSandboxCleared(now = Date.now()): void {
  sandboxPending = null;
  accountGame = null;
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = null;
  const player = readPlayer();
  if (player) void push(player, { sandbox: { cleared: now } });
}

/**
 * Before the sandbox opens: if the account holds a newer game than this device, write it here so
 * the sandbox opens on it. Gives up after `wait` ms (a slow or absent line), leaving this device's
 * copy. Resolves true when it brought a game down.
 */
export async function pullSandbox(wait = SANDBOX_PULL_WAIT_MS): Promise<boolean> {
  const player = readPlayer();
  if (!player) return false;
  const answer = await Promise.race([
    loadApi()
      .then(({ api }) => api.sync(player.secret))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), wait)),
  ]);
  return takeSandbox(answer);
}

function takeSandbox(answer: SyncResponse | null): boolean {
  if (answer) accountGame = gameOf(answer.sandbox?.body ?? null);
  if (!answer?.sandbox) return false;
  if (answer.sandbox.savedAt <= savedAtOf(get(SANDBOX_KEY))) return false;
  set(SANDBOX_KEY, answer.sandbox.body);
  return true;
}

/**
 * A device has just signed in, or opened signed in: bring it and the account level. Whichever
 * side changed its settings last wins, and a sandbox game newer here than in the account goes up
 * (a guest's game is kept when they sign in with Google).
 */
export async function reconcile(player: StoredPlayer): Promise<void> {
  let answer: SyncResponse;
  try {
    const { api } = await loadApi();
    answer = await api.sync(player.secret);
  } catch {
    return;
  }
  if (readPlayer()?.id !== player.id) return;
  const mine = localPrefs();
  const update: Parameters<typeof push>[1] = {};
  if (answer.prefs && (answer.prefsAt ?? 0) > mine.at) {
    applyPrefs?.(answer.prefs);
    set(PREFS_AT_KEY, String(answer.prefsAt));
  } else if (mine.at > (answer.prefsAt ?? 0)) {
    update.prefs = { at: mine.at, value: mine.value };
  }
  const here = get(SANDBOX_KEY);
  const hereAt = savedAtOf(here);
  if (here && hereAt > (answer.sandbox?.savedAt ?? 0)) {
    update.sandbox = { savedAt: hereAt, body: here };
    accountGame = gameOf(here);
  } else takeSandbox(answer);
  if (update.prefs || update.sandbox) await push(player, update);
}

/**
 * Before an account signs out of this device: send the sandbox game still waiting to go up, then,
 * for an account that signs in with Google, take its game off this device (the account keeps it,
 * and the next person here should not open on it).
 */
export async function settleBeforeSignOut(player: StoredPlayer): Promise<void> {
  const body = sandboxPending;
  sandboxPending = null;
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = null;
  const savedAt = savedAtOf(body);
  if (body && savedAt > 0) await push(player, { sandbox: { savedAt, body } });
  accountGame = null;
  if (player.google) {
    try {
      local()?.removeItem(SANDBOX_KEY);
    } catch {
      // nothing to remove
    }
  }
}

let started = false;

/** Keep this device and the account level for as long as the page is open. Once per page. */
export function startSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  let seen: string | null = null;
  const check = () => {
    const player = readPlayer();
    const id = player?.id ?? null;
    if (id === seen) return;
    seen = id;
    if (player) void reconcile(player);
  };
  subscribePlayer(check);
  check();
  // A tab going to the background may never come back: send what is waiting now.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && sandboxPending) flushSandbox();
  });
}
