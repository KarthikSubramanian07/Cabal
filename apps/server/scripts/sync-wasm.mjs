// Copies the engine wasm into the worker tree so Wrangler's module rules can see it.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../../packages/engine/pkg/cabal_engine_bg.wasm");
const dest = resolve(here, "../src/engine/cabal_engine_bg.wasm");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`synced ${src} -> ${dest}`);
