/** Loads the Rust engine in the browser from the wasm-pack output. */
import wasmUrl from "@cabal/engine/wasm?url";
import { ready } from "@cabal/engine";

let loading: Promise<void> | undefined;

/**
 * Fetch and compile the engine. The fetch happens here, not inside `ready`, because `ready`
 * remembers its first attempt for good: handing it a module that is known to have arrived
 * means a dropped connection can be retried.
 */
async function load(): Promise<void> {
  const url = new URL(wasmUrl, window.location.href);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compileStreaming(fetch(url));
  } catch (err) {
    // A network failure is final for this attempt. A server that sends the wrong content
    // type makes streaming compilation refuse the response, so compile from the bytes.
    const response = await fetch(url);
    if (!response.ok) throw err;
    module = await WebAssembly.compile(await response.arrayBuffer());
  }
  await ready(module);
}

/** Resolves once the engine can be called. A failed load is forgotten so a retry fetches again. */
export function engineReady(): Promise<void> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

export * from "@cabal/engine";
