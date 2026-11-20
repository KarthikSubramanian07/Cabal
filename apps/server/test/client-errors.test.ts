/** `POST /api/errors`: a page that broke tells the server, which writes one anonymous log line. */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { scrubMessage } from "../src/client-errors.js";
import { nextIp, serverEnv } from "./helpers.js";

const report = (body: unknown, headers: Record<string, string> = {}, ip = nextIp()) =>
  worker.fetch(
    new Request("http://cabal/api/errors", {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "text/plain", ...headers },
      body: JSON.stringify(body),
    }),
    { ...serverEnv, BUILD_ID: "3b30e06c5d9a" },
  );

/** Every structured line written at error level while `fn` runs. */
async function errorLines(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(JSON.parse(String(line)) as Record<string, unknown>));
  await fn();
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("client error reports", () => {
  it("logs a report as one client_error line naming the page, the build and nothing about the sender", async () => {
    let status = 0;
    const lines = await errorLines(async () => {
      const res = await report(
        { kind: "crash", message: "Cannot read properties of undefined (reading 'units')", route: "game", where: "/assets/GamePage-abc123.js:1:2048" },
        { origin: "http://cabal" },
      );
      status = res.status;
    });
    expect(status).toBe(204);
    const line = lines.find((l) => l["event"] === "client_error");
    expect(line).toMatchObject({
      level: "error",
      kind: "crash",
      page: "game",
      message: "Cannot read properties of undefined (reading 'units')",
      where: "/assets/GamePage-abc123.js:1:2048",
      continent: "XX",
      build: "3b30e06c5d9a",
    });
    expect(JSON.stringify(line)).not.toContain("cf-connecting-ip");
  });

  it("masks addresses, tokens and codes a message quotes", () => {
    expect(scrubMessage("fetch https://playcabal.pages.dev/g/ABC123?x=1 failed")).toBe("fetch <url>/g failed");
    expect(scrubMessage("bad seat token st_9f8e7d6c5b4a39281706")).toBe("bad seat token <id>");
    expect(scrubMessage("two\n\nlines")).toBe("two lines");
    // A table's code says which table broke: masked, in any case, digits or none. Words and the
    // six-letter powers are not codes.
    expect(scrubMessage("no such game K7Q2XZ")).toBe("no such game <code>");
    expect(scrubMessage("no such game k7q2xz")).toBe("no such game <code>");
    expect(scrubMessage("seat ABCDEF is taken")).toBe("seat <code> is taken");
    expect(scrubMessage("FRANCE cannot move: failed")).toBe("FRANCE cannot move: failed");
    expect(scrubMessage("Cannot render object")).toBe("Cannot render object");
    expect(scrubMessage("x".repeat(400))).toHaveLength(300);
  });

  it("refuses a report from another site's page, a malformed one, and a flood from one address", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await report({ kind: "error", message: "boom", route: "home" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await report({ kind: "error", message: "", route: "home" })).status).toBe(400);
    // A route is a name, never an address with a game code or a handle in it.
    expect((await report({ kind: "error", message: "boom", route: "/g/ABC123" })).status).toBe(400);
    expect((await report({ kind: "explosion", message: "boom", route: "home" })).status).toBe(400);
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await report({ kind: "error", message: `boom ${i}`, route: "home" }, {}, ip)).status);
    expect(statuses.slice(0, 6)).toEqual([204, 204, 204, 204, 204, 204]);
    expect(statuses.slice(6)).toEqual([429, 429]);
    quiet.mockRestore();
  });

  it("is a POST only", async () => {
    const res = await worker.fetch(new Request("http://cabal/api/errors"), serverEnv);
    expect(res.status).toBe(404);
  });
});
