import { readFileSync, readdirSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { unstable_readConfig } from "wrangler";
import { defineConfig } from "vitest/config";

/** Secrets the server reads. Tests never see a real one, whatever the developer's machine holds. */
const SECRETS = ["ANTHROPIC_API_KEY", "VAPID_PRIVATE_KEY", "ADMIN_TOKEN", "BUILD_ID"];

/**
 * Every key a developer's local env files define (`.dev.vars`, `.env` and their per-environment
 * variants next to wrangler.jsonc). Wrangler folds those files into the Worker's bindings, so a
 * VAPID key or an Anthropic key kept there for `wrangler dev` would otherwise reach the tests:
 * push would switch on, and a Claude seat could make a real, paid call.
 */
export function localEnvKeys(dir = "."): string[] {
  const files = readdirSync(dir).filter((f) => /^\.(dev\.vars|env)(\..+)?$/.test(f));
  const keys = files.flatMap((f) =>
    readFileSync(`${dir}/${f}`, "utf8")
      .split(/\r?\n/)
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((k): k is string => k !== undefined),
  );
  return [...new Set(keys)];
}

/**
 * The bindings tests run with in place of whatever local env files say: a secret is blank, and a
 * plain setting a local file overrides is put back to the value wrangler.jsonc gives it (or blank
 * where the config has none, as on a deployment that never set it).
 */
function hermeticBindings(): Record<string, string> {
  const vars = (unstable_readConfig({ config: "./wrangler.jsonc" }, { hideWarnings: true }).vars ?? {}) as Record<string, unknown>;
  const keys = new Set([...SECRETS, ...localEnvKeys()]);
  return Object.fromEntries([...keys].map((k) => [k, !SECRETS.includes(k) && typeof vars[k] === "string" ? (vars[k] as string) : ""]));
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ...hermeticBindings(),
          // The Registry is one object shared by every test in a run, so the deployment-wide Claude
          // budget is set wide open here; budget.test.ts narrows it to test the limits themselves.
          CLAUDE_USD_PER_DAY: "1000000",
          CLAUDE_ACTIVE_GAMES: "1000000",
          // The operator's token for the metrics routes. Push stays off unless a suite turns it on
          // with its own keys (push.test.ts), as on a deployment without the VAPID secret.
          ADMIN_TOKEN: "test-admin-token",
          // The real migration files, applied to the local D1 database before any test runs
          // (test/setup.ts), so tests and production share one schema.
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  // Tests drive real sockets, alarms and a queue inside workerd; leave room for a busy CI runner.
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
