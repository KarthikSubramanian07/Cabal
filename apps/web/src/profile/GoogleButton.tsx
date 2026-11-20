/**
 * Google's own "Continue with Google" button, shown only when the deployment has a Google client
 * ID. While Google's script loads, nothing jumps: the space is held at the button's height.
 */
import { useEffect, useRef, useState } from "react";
import { drawGoogleButton, googleClientId } from "../net/google.js";

export function GoogleButton({ onCredential, text = "continue_with", className }: { onCredential: (credential: string) => void; text?: "continue_with" | "signin_with"; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(onCredential);
  latest.current = onCredential;
  const [state, setState] = useState<"loading" | "ready" | "off" | "failed">("loading");

  useEffect(() => {
    let live = true;
    void googleClientId().then(async (id) => {
      if (!live) return;
      if (!id || !host.current) return setState("off");
      try {
        await drawGoogleButton(host.current, id, (credential) => latest.current(credential), text);
        if (live) setState("ready");
      } catch {
        if (live) setState("failed");
      }
    });
    return () => {
      live = false;
    };
  }, [text]);

  if (state === "off") return null;
  return (
    <div className={`google-signin${className ? ` ${className}` : ""}`} data-state={state}>
      <div ref={host} className="google-signin-button" />
      {state === "failed" ? <p className="field-note">Google sign-in could not load here. Pick a handle instead; you can link Google later.</p> : null}
    </div>
  );
}

/** Whether this deployment offers Google sign-in (false until it has answered). */
export function useGoogleSignInOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void googleClientId().then((id) => live && setOn(id !== null));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
