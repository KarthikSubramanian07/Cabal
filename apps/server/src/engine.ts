/**
 * Loads the Rust engine once per isolate. The `.wasm` is synced into this tree by
 * `scripts/sync-wasm.mjs` (run before build, test and deploy) so Wrangler compiles
 * it into a `WebAssembly.Module` through the `CompiledWasm` rule.
 */
import { ready } from "@cabal/engine";
import wasm from "./engine/cabal_engine_bg.wasm";

let done: Promise<void> | undefined;

export function engineReady(): Promise<void> {
  done ??= ready(wasm);
  return done;
}

export * from "@cabal/engine";
