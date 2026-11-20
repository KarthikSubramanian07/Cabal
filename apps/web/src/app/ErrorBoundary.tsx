import { Component, type ErrorInfo, type ReactNode } from "react";
import { errors } from "../net/errors.js";
import { StatusPage } from "./StatusPage.jsx";

/** Catches a crash or a failed lazy chunk so the player gets a way back, not a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Cabal crashed", error, info.componentStack);
    // The player sees a way back; the server hears what broke (net/errors.ts).
    errors.report("crash", error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <StatusPage
        stamp="Halted"
        tone="alert"
        title="Something on this page broke."
        pageTitle="Something broke"
        actions={
          <button type="button" className="btn brass" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        }
      >
        <p>Reloading usually fixes it. A sandbox game in progress is saved on this device and will be restored.</p>
        <p className="status-detail">
          <code>{error.message}</code>
        </p>
      </StatusPage>
    );
  }
}
