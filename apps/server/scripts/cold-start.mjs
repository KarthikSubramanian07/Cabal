#!/usr/bin/env node
/**
 * Cold start harness for the GameRoom (issue #61).
 *
 * Each run starts a fresh `wrangler dev` (a new workerd process, so a new isolate with nothing
 * loaded), then plays the shortest path to a first adjudication through the public API only:
 * create a game, start it with AI seats, connect the creator's socket, ready up, wait for results.
 * It times each step from outside and reads the engine's own three timings from the structured
 * log lines the server writes once per isolate (`engine_ready`, `engine_first_game`,
 * `engine_first_process`, see src/engine.ts).
 *
 *   node scripts/cold-start.mjs [--runs 7] [--out result.json]
 *                               [--budget cold-start-budget.json] [--compare base.json]
 *                               [--ratio 1.5] [--slack 5]
 *
 * `--budget` fails the run when a median is over its ceiling; `--compare` fails it when a median
 * is more than `ratio` times the base run's plus `slack` milliseconds. Both print why.
 * Run `pnpm engine:sync` first (the npm script `cold-start` does).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { overBudget, regressions, summarise } from "../src/stats.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");
const wrangler = join(serverDir, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "7" },
    out: { type: "string" },
    budget: { type: "string" },
    compare: { type: "string" },
    ratio: { type: "string", default: "1.5" },
    slack: { type: "string", default: "5" },
  },
});
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("--runs must be 1 to 50");

/** What the gate compares against the base commit: the engine's parts and the requests that pay them. */
const RELATIVE = ["instantiateMs", "firstGameMs", "firstProcessMs", "createMs", "firstAdjudicationMs"];
const METRICS = ["instantiateMs", "firstGameMs", "firstProcessMs", "createMs", "startMs", "firstAdjudicationMs", "bootMs"];
const LABELS = {
  instantiateMs: "Engine instantiation (in workerd)",
  firstGameMs: "First game built in the room (in workerd)",
  firstProcessMs: "First adjudication, engine only (in workerd)",
  createMs: "First request: create a game (fresh isolate)",
  startMs: "Start with AI seats (bots order)",
  firstAdjudicationMs: "Ready to results frame, first phase",
  bootMs: "wrangler dev boot (tooling, not gated)",
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const run = (command, argv, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${argv.join(" ")} exited ${code}\n${output}`))));
  });

const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };

/** Every JSON object the server logged, in order. */
function logLines(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const start = raw.indexOf("{");
    if (start < 0) continue;
    try {
      const line = JSON.parse(raw.slice(start));
      if (line && typeof line.event === "string") out.push(line);
    } catch {
      // wrangler's own output
    }
  }
  return out;
}

const until = async (probe, what, timeoutMs = 30_000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function once(persistTo, n) {
  const port = await freePort();
  const inspector = await freePort();
  const spawnedAt = performance.now();
  const child = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persistTo, "--var", "BUILD_ID:cold-start"],
    { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"], env },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    await until(() => /Ready on http/.test(output), "wrangler dev to be ready", 120_000);
    const bootMs = performance.now() - spawnedAt;
    const origin = `http://127.0.0.1:${port}`;
    const post = (path, body, token) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    let t = performance.now();
    const created = await post("/api/games", { name: "Cold start probe", settings: { aiFill: true, press: "gunboat" } });
    const createMs = performance.now() - t;
    if (!created.ok) throw new Error(`create: ${created.status} ${await created.text()}`);
    const { gameId, token } = await created.json();

    t = performance.now();
    const started = await post(`/api/games/${gameId}/start`, undefined, token);
    const startMs = performance.now() - t;
    if (!started.ok) throw new Error(`start: ${started.status} ${await started.text()}`);
    const { phase } = await started.json();

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/games/${gameId}/ws`);
    const frames = [];
    socket.addEventListener("message", (ev) => {
      if (ev.data !== "pong") frames.push(JSON.parse(String(ev.data)));
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    });
    socket.send(JSON.stringify({ t: "hello", p: { token } }));
    await until(() => frames.some((f) => f.t === "welcome" && f.p.power), "the seat's welcome");
    t = performance.now();
    socket.send(JSON.stringify({ t: "ready", p: { phase, ready: true } }));
    await until(() => frames.some((f) => f.t === "results"), "the first results frame");
    const firstAdjudicationMs = performance.now() - t;
    socket.close();

    const lines = await until(() => {
      const all = logLines(output);
      const has = (event) => all.find((l) => l.event === event);
      return has("engine_ready") && has("engine_first_game") && has("engine_first_process") ? all : null;
    }, "the engine's timing lines", 10_000);
    const pick = (event, field) => lines.find((l) => l.event === event)[field];
    const sample = {
      run: n,
      engine: pick("engine_ready", "engine"),
      instantiateMs: pick("engine_ready", "instantiateMs"),
      firstGameMs: pick("engine_first_game", "ms"),
      firstProcessMs: pick("engine_first_process", "ms"),
      createMs,
      startMs,
      firstAdjudicationMs,
      bootMs,
    };
    for (const k of METRICS) sample[k] = Math.round(sample[k] * 100) / 100;
    return sample;
  } catch (error) {
    console.error(output.slice(-4000));
    throw error;
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
}

const persistTo = mkdtempSync(join(tmpdir(), "cabal-cold-start-"));
const samples = [];
try {
  await run(wrangler, ["d1", "migrations", "apply", "cabal", "--local", "--persist-to", persistTo], { env });
  for (let n = 1; n <= runs; n++) {
    const sample = await once(persistTo, n);
    samples.push(sample);
    console.log(`run ${n}/${runs}: ${METRICS.map((k) => `${k}=${sample[k]}`).join(" ")}`);
  }
} finally {
  rmSync(persistTo, { recursive: true, force: true });
}

const summary = Object.fromEntries(METRICS.map((k) => [k, summarise(samples.map((s) => s[k]))]));
const result = { engine: samples[0]?.engine ?? null, node: process.version, platform: `${process.platform}-${process.arch}`, runs, summary, samples };
if (args.out) writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);

const table = [
  "| Step | Median ms | p90 ms | Min | Max |",
  "|---|---:|---:|---:|---:|",
  ...METRICS.map((k) => `| ${LABELS[k]} | ${summary[k]?.median} | ${summary[k]?.p90} | ${summary[k]?.min} | ${summary[k]?.max} |`),
].join("\n");
console.log(`\nCold start, ${runs} fresh workerd processes, engine ${result.engine}, Node ${process.version}\n\n${table}\n`);

const problems = [];
if (args.budget) {
  const ceilings = JSON.parse(readFileSync(args.budget, "utf8")).ceilingsMs;
  for (const over of overBudget(summary, ceilings)) problems.push(`${over.metric}: median ${over.median} ms is over its ${over.ceiling} ms ceiling`);
}
if (args.compare) {
  const base = JSON.parse(readFileSync(args.compare, "utf8"));
  const found = regressions(base.summary, summary, RELATIVE, Number(args.ratio), Number(args.slack));
  for (const r of found) problems.push(`${r.metric}: median ${r.head} ms against ${r.base} ms on the base commit (limit ${r.limit} ms)`);
  const lines = RELATIVE.map((k) => `| ${LABELS[k]} | ${base.summary[k]?.median ?? "n/a"} | ${summary[k]?.median ?? "n/a"} |`);
  console.log(`Against the base commit (median ms; fails over ${args.ratio} times plus ${args.slack} ms):\n\n| Step | Base | This change |\n|---|---:|---:|\n${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Against the base commit\n\n| Step | Base | This change |\n|---|---:|---:|\n${lines.join("\n")}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### GameRoom cold start\n\n${runs} fresh workerd processes, engine ${result.engine}.\n\n${table}\n`);
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
