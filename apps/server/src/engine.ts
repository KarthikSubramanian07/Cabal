/**
 * Loads the Rust engine once per isolate. Wrangler compiles the `.wasm` import
 * into a `WebAssembly.Module` (see the `CompiledWasm` rule in wrangler.jsonc).
 */
import wasm from "@cabal/engine/wasm";
import { ready } from "@cabal/engine";

let done: Promise<void> | undefined;

export function engineReady(): Promise<void> {
  done ??= ready(wasm as unknown as WebAssembly.Module);
  return done;
}

export * from "@cabal/engine";
