// `pnpm --filter @cabal/server run deploy` (and so `pnpm deploy:server` and `pnpm deploy:all`):
// apply the D1 migrations to the remote database, then deploy the Worker stamped with the commit it
// was built from, so `curl /health` answers which commit is live. Arguments after `--` go to
// `wrangler deploy` (for example `-- --dry-run --outdir /tmp/out`, which also skips the migrations).
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdFor, deployArgs } from "./build-id.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const extra = process.argv.slice(2).filter((a) => a !== "--");
const dryRun = extra.includes("--dry-run");

const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const buildId = buildIdFor(commit, dirty);
if (dirty) console.warn(`deploy: the working tree has uncommitted changes; /health will report ${buildId}`);

function wrangler(args) {
  console.log(`$ wrangler ${args.join(" ")}`);
  // The package's own wrangler, whether this runs from a pnpm script or straight from node.
  const bin = resolve(root, "node_modules/.bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const run = spawnSync(bin, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

// The schema goes first, so a Worker never runs ahead of it (/health answers 503 if one did).
if (!dryRun) wrangler(["d1", "migrations", "apply", "cabal", "--remote"]);
wrangler(deployArgs(buildId, git("log", "-1", "--format=%s"), extra));
console.log(`deploy: ${dryRun ? "bundled" : "deployed"} build ${buildId}`);
