// Frame rate and layout work while a busy phase plays on the board, on a phone-sized page with
// the CPU throttled through the DevTools protocol (4x stands in for a mid-range phone).
//
//   pnpm build && pnpm preview &           # the site as served
//   node scripts/motion-perf.mjs http://localhost:4173 [throttle=4] [reduced=no|yes]
//   TRACE=1 node scripts/motion-perf.mjs ...   # also count forced (script-triggered) layouts
//
// Prints JSON: frames per second after the first frame, the median and 95th percentile frame
// time, frames over 25 ms, and the layout and style work done while the phase played.
import { chromium, devices } from "@playwright/test";

const [origin = "http://localhost:4173", throttle = "4", reduced = "no"] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["Pixel 7"], reducedMotion: reduced === "yes" ? "reduce" : "no-preference" });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await page.goto(origin);
await page.locator("svg.board text.label").first().waitFor({ timeout: 30000 });
// Busy spring: most units move, several bounce, supports and a convoy.
const orders = [
  "A PAR - BUR; A MAR S A PAR - BUR; F BRE - MAO",
  "A MUN - BUR; A BER - KIE; F KIE - DEN",
  "F LON - NTH; F EDI - NWG; A LVP - YOR",
  "A VEN - TYR; A ROM - VEN; F NAP - ION",
  "A VIE - GAL; A BUD - SER; F TRI - ALB",
  "A WAR - GAL; A MOS - UKR; F SEV - BLA; F STP/SC - BOT",
  "F ANK - BLA; A CON - BUL; A SMY - ARM",
].join("; ");
const bar = page.locator(".sheet-bar");
if (await bar.isVisible()) await bar.click();
const field = page.getByRole("combobox", { name: "Write an order" });
await field.fill(orders);
await field.press("Enter");
if (await bar.isVisible()) await bar.click();
await page.waitForTimeout(500);
await cdp.send("Performance.enable");
await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(throttle) });
const traceEvents = [];
const tracing = process.env.TRACE === "1";
if (tracing) {
  cdp.on("Tracing.dataCollected", (e) => traceEvents.push(...e.value));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
}
const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const result = await page.evaluate(() => new Promise((resolve) => {
  const times = [];
  const start = performance.now();
  document.querySelector(".sidebar .actions .btn.primary").click();
  const tick = (t) => {
    times.push(t);
    if (t - start < 2600) requestAnimationFrame(tick);
    else resolve(times);
  };
  requestAnimationFrame(tick);
}));
const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
let forced = null;
let byName = null;
if (tracing) {
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await done;
  const main = traceEvents.filter((e) => e.ph === "X" && e.dur);
  byName = {};
  for (const e of main) if (["Layout", "UpdateLayoutTree", "Paint", "FunctionCall", "TimerFire", "FireAnimationFrame", "EventDispatch", "Commit", "PrePaint", "Layerize"].includes(e.name)) byName[e.name] = Math.round(((byName[e.name] ?? 0) + e.dur / 1000) * 10) / 10;
  // A layout with a JavaScript stack is one script forced, mid-frame: the mark of layout thrash.
  forced = traceEvents.filter((e) => e.name === "Layout" && e.args?.beginData?.stackTrace?.length).length;
}
const gaps = result.slice(1).map((t, i) => t - result[i]);
// The first frame carries the click itself (React rendering the results); report it apart.
const first = gaps[0];
const rest = gaps.slice(1);
const sorted = [...rest].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const span = result.at(-1) - result[1];
console.log(JSON.stringify({
  throttle: Number(throttle),
  reducedMotion: reduced === "yes",
  firstFrameMs: Math.round(first),
  frames: rest.length,
  fps: Math.round((rest.length / span) * 1000 * 10) / 10,
  medianFrameMs: Math.round(pct(0.5) * 10) / 10,
  p95FrameMs: Math.round(pct(0.95) * 10) / 10,
  longFrames: rest.filter((g) => g > 25).length,
  layouts: after.LayoutCount - before.LayoutCount,
  styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
  layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
  scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
  forcedLayouts: forced,
  mainThreadMsByEvent: byName,
}, null, 1));
await browser.close();
