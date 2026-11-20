/**
 * Lets Node run this package's TypeScript sources directly (`node --experimental-transform-types
 * --import ./scripts/ts-hooks.mjs src/...`): the sources import each other as `./x.js`, the way the
 * bundlers and the type checker expect, and this hook finds `./x.ts` when there is no `./x.js`.
 * No compiler and no extra dependency.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
