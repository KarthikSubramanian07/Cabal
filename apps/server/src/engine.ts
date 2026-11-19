/**
 * Loads the Rust engine once per isolate. The `.wasm` is synced into this tree by
 * `scripts/sync-wasm.mjs` (run before build, test and deploy) so Wrangler compiles
 * it into a `WebAssembly.Module` through the `CompiledWasm` rule.
 *
 * It also times the engine's cold start, once per isolate, in three parts: instantiating the
 * module (`engine_ready`), the first game a room builds (`engine_first_game`) and the first phase
 * it adjudicates (`engine_first_process`). Each is one structured log line, the channel
 * `scripts/cold-start.mjs` reads in CI and Workers Logs keeps in production. In production the
 * clock does not advance during pure computation, so there the numbers read near zero and the
 * real figure is the invocation's `cpuTime` in Workers Logs; under workerd locally and in CI the
 * clock runs and the numbers are real.
 */
import { ready, version } from "@cabal/engine";
import wasm from "./engine/cabal_engine_bg.wasm";
import { log } from "./log.js";

let done: Promise<void> | undefined;

/** What this isolate has measured so far; each part is set once. */
export const coldStart: { instantiateMs: number | null; firstGameMs: number | null; firstProcessMs: number | null } = {
  instantiateMs: null,
  firstGameMs: null,
  firstProcessMs: null,
};

const round = (ms: number) => Math.round(ms * 100) / 100;

export function engineReady(): Promise<void> {
  done ??= (async () => {
    const started = performance.now();
    await ready(wasm);
    coldStart.instantiateMs = round(performance.now() - started);
    log("engine_ready", { engine: version(), instantiateMs: coldStart.instantiateMs });
  })();
  return done;
}

/**
 * Run `work` and, the first time this isolate does that kind of work, log how long it took.
 * Later calls cost one comparison.
 */
export function timedFirst<T>(part: "firstGameMs" | "firstProcessMs", work: () => T): T {
  if (coldStart[part] !== null) return work();
  const started = performance.now();
  const result = work();
  coldStart[part] = round(performance.now() - started);
  log(part === "firstGameMs" ? "engine_first_game" : "engine_first_process", { engine: version(), ms: coldStart[part] });
  return result;
}

export * from "@cabal/engine";
