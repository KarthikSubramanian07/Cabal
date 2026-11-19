/** Loads the Rust engine in the browser from the wasm-pack output. */
import wasmUrl from "@cabal/engine/wasm?url";
import { ready } from "@cabal/engine";

let loading: Promise<void> | undefined;

/** Resolves once the engine can be called. A failed load is forgotten so a retry fetches again. */
export function engineReady(): Promise<void> {
  loading ??= ready(new URL(wasmUrl, window.location.href)).catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

export * from "@cabal/engine";
