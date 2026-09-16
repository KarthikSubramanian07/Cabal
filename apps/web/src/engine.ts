/** Loads the Rust engine in the browser from the wasm-pack output. */
import wasmUrl from "@cabal/engine/wasm?url";
import { ready } from "@cabal/engine";

let loading: Promise<void> | undefined;

export function engineReady(): Promise<void> {
  loading ??= ready(new URL(wasmUrl, window.location.href));
  return loading;
}

export * from "@cabal/engine";
