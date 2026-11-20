/**
 * A local `cabal-server` for one arena run: the engine module synced, the D1 migrations applied
 * to a store of its own (`apps/server/.wrangler/arena`), then `wrangler dev`, waited on until
 * `/health` answers. Nothing leaves the machine. The server is started without the Anthropic key,
 * so its own AI seats (there are none in an arena game) could never call the API either.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("../../../../apps/server/", import.meta.url));
const STORE = ".wrangler/arena";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: SERVER_DIR, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

export interface LocalServer {
  url: string;
  stop(): Promise<void>;
}

export async function startWrangler(port = 8799, log: (line: string) => void = () => {}): Promise<LocalServer> {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: process.env.CI ?? "1" };
  delete env.ANTHROPIC_API_KEY;
  log("syncing the engine module and applying local D1 migrations");
  await run("node", ["scripts/sync-wasm.mjs"], env);
  await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "cabal", "--local", "--persist-to", STORE], env);
  log(`starting wrangler dev on port ${port}`);
  const child: ChildProcess = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(port), "--persist-to", STORE, "--show-interactive-dev-session=false"],
    { cwd: SERVER_DIR, env, stdio: ["ignore", "ignore", "inherit"], detached: process.platform !== "win32" },
  );
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    try {
      // wrangler runs workerd as a child of its own: end the whole group.
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  };
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode} before it was ready`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { url, stop };
    } catch {
      // not listening yet
    }
    if (Date.now() > until) {
      await stop();
      throw new Error("wrangler dev did not answer /health within two minutes");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
