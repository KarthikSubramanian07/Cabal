import { ClientErrorReport } from "@cabal/protocol";
import { describe, expect, it } from "vitest";
import { MAX_REPORTS, createErrorReporter, topFrame } from "./errors.js";

function setup(path = "/g/ABC123", beacon = true) {
  const sent: Blob[] = [];
  const reporter = createErrorReporter({
    path: () => path,
    sendBeacon: beacon
      ? (url, data) => {
          expect(url).toBe("/api/errors");
          sent.push(data);
          return true;
        }
      : undefined,
  });
  const bodies = async () => Promise.all(sent.map(async (b) => ClientErrorReport.parse(JSON.parse(await b.text()))));
  return { reporter, bodies };
}

const thrown = (message: string, stack: string) => Object.assign(new Error(message), { stack });

describe("error reports", () => {
  it("names the route, never the address, and the top frame without the origin", async () => {
    const { reporter, bodies } = setup("/g/ABC123");
    const error = thrown("units is undefined", "TypeError: units is undefined\n    at Board (https://playcabal.pages.dev/assets/GamePage-abc.js?v=1:3:2048)\n    at x (https://playcabal.pages.dev/assets/index.js:1:1)");
    expect(reporter.report("crash", error)).toBe(true);
    const [body] = await bodies();
    expect(body).toEqual({ kind: "crash", message: "units is undefined", route: "game", where: "/assets/GamePage-abc.js:3:2048" });
    expect(JSON.stringify(body)).not.toContain("ABC123");
    expect(JSON.stringify(body)).not.toContain("playcabal.pages.dev");
  });

  it("calls a page no route matches `none`, and names a failed chunk as such", async () => {
    const { reporter, bodies } = setup("/nowhere/at/all");
    reporter.report("rejection", new TypeError("Failed to fetch dynamically imported module: https://playcabal.pages.dev/assets/Ledger.js"));
    expect(await bodies()).toMatchObject([{ kind: "chunk", route: "none", message: "TypeError: Failed to fetch dynamically imported module: /assets/Ledger.js" }]);
  });

  it("sends the same failure once, and at most a handful from one page load", async () => {
    const { reporter, bodies } = setup("/");
    for (let i = 0; i < 3; i++) reporter.report("error", new Error("tick"));
    for (let i = 0; i < 20; i++) reporter.report("error", new Error(`loop ${i}`));
    const sent = await bodies();
    expect(sent).toHaveLength(MAX_REPORTS);
    expect(sent.filter((b) => b.message === "tick")).toHaveLength(1);
  });

  it("reports thrown strings and objects, and skips an empty message", async () => {
    const { reporter, bodies } = setup("/ledger");
    reporter.report("rejection", "plain string");
    reporter.report("rejection", { code: 7 });
    reporter.report("error", "   ");
    expect((await bodies()).map((b) => b.message)).toEqual(["plain string", '{"code":7}']);
  });

  it("costs nothing where the browser cannot send a beacon", () => {
    const { reporter } = setup("/", false);
    expect(reporter.report("error", new Error("x"))).toBe(false);
  });

  it("reads a frame from Chrome, Firefox and Safari stacks", () => {
    expect(topFrame("Error: x\n    at f (http://localhost:4173/assets/a.js:10:20)")).toBe("/assets/a.js:10:20");
    expect(topFrame("f@https://playcabal.pages.dev/assets/b.js:3:4\n")).toBe("/assets/b.js:3:4");
    expect(topFrame("no frames here")).toBeUndefined();
    expect(topFrame(undefined)).toBeUndefined();
  });
});
