/**
 * Sign in with Google in the browser: the deployment's client ID, Google Identity Services'
 * script (loaded only when a sign-in button is about to show), and its official button. The
 * button hands back a signed ID token, which the server checks (apps/server/src/google.ts).
 */
import { loadApi } from "./lazy.js";

const GSI_SRC = "https://accounts.google.com/gsi/client";

interface CredentialResponse {
  credential: string;
}

interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    ux_mode?: "popup" | "redirect";
    use_fedcm_for_button?: boolean;
    itp_support?: boolean;
    context?: "signin" | "signup" | "use";
  }): void;
  renderButton(
    parent: HTMLElement,
    options: { type?: "standard" | "icon"; theme?: string; size?: string; text?: string; shape?: string; logo_alignment?: string; width?: number },
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

let clientId: Promise<string | null> | null = null;

/** This deployment's Google client ID, or null when Google sign-in is off (or cannot be asked). */
export function googleClientId(): Promise<string | null> {
  clientId ??= loadApi()
    .then(({ api }) => api.googleConfig())
    .then((c) => c.clientId)
    .catch(() => {
      clientId = null; // ask again next time
      return null;
    });
  return clientId;
}

let script: Promise<GoogleIdentity> | null = null;

/** Google Identity Services, loaded once. */
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  script ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const ready = () => window.google?.accounts?.id;
    if (ready()) return resolve(ready()!);
    const tag = document.createElement("script");
    tag.src = GSI_SRC;
    tag.async = true;
    tag.onload = () => (ready() ? resolve(ready()!) : reject(new Error("Google sign-in did not start")));
    tag.onerror = () => reject(new Error("Google sign-in could not be loaded"));
    document.head.append(tag);
  }).catch((error: unknown) => {
    script = null;
    throw error;
  });
  return script;
}

/** Who hears the next answer from Google: the button drawn last. */
let answer: ((credential: string) => void) | null = null;
/** The client ID Google Identity Services was started with, once it has been. */
let startedWith: string | null = null;

/**
 * Draw Google's button into `parent`. Google Identity Services is started once per page:
 * starting it again cancels a sign-in already under way (FedCM aborts its request), so every
 * later button only takes over who hears the answer. The latest button drawn is that one.
 */
export async function drawGoogleButton(parent: HTMLElement, id: string, onCredential: (credential: string) => void, text: "continue_with" | "signin_with" = "continue_with") {
  const gsi = await loadGoogleIdentity();
  answer = onCredential;
  if (startedWith !== id) {
    gsi.initialize({ client_id: id, callback: (r) => answer?.(r.credential), ux_mode: "popup", use_fedcm_for_button: true, itp_support: true, context: "use" });
    startedWith = id;
  }
  parent.replaceChildren();
  gsi.renderButton(parent, { type: "standard", theme: "outline", size: "large", text, shape: "rectangular", logo_alignment: "left", width: Math.min(320, Math.max(200, Math.floor(parent.clientWidth || 280))) });
}

/** For tests: forget that Google Identity Services was started. */
export function forgetGoogleStart(): void {
  answer = null;
  startedWith = null;
}
