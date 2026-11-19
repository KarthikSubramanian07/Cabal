/**
 * Install Cabal as an app, where the browser offers it. Froggo21's `beforeinstallprompt`
 * handling from the first version of this work, kept and finished:
 *
 *  - the event is caught from the first moment the page runs (`listenForInstall` in main.tsx),
 *    because the browser may fire it before React has drawn the button;
 *  - the saved prompt is spent by any answer, so the button goes away after a dismissal as well
 *    as an install, and also when the app is installed some other way;
 *  - where the browser offers no prompt (Safari, Firefox, an installed app) nothing is drawn,
 *    rather than a claim that cannot be backed up.
 */
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let saved: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function set(event: BeforeInstallPromptEvent | null) {
  saved = event;
  for (const l of listeners) l();
}

export function listenForInstall(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    set(event as BeforeInstallPromptEvent);
  });
  window.addEventListener("appinstalled", () => set(null));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function InstallButton({ onDone }: { onDone?: () => void }) {
  const prompt = useSyncExternalStore(subscribe, () => saved, () => null);
  if (!prompt) return null;
  return (
    <button
      type="button"
      onClick={() => {
        set(null);
        onDone?.();
        void prompt.prompt().catch(() => undefined);
      }}
    >
      Install app
    </button>
  );
}
