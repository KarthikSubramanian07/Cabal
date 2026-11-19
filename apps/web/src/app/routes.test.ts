import { describe, expect, it } from "vitest";
import { matchRoute, pathFor } from "./routes.js";

describe("matchRoute", () => {
  it("serves the front door at the root and the sandbox at /sandbox", () => {
    expect(matchRoute("/")).toEqual({ name: "home", params: {} });
    expect(matchRoute("/sandbox")).toEqual({ name: "sandbox", params: {} });
    expect(matchRoute("/sandbox/")).toEqual({ name: "sandbox", params: {} });
  });

  it("captures game codes, handles and replay codes", () => {
    expect(matchRoute("/g/K7Q2")).toEqual({ name: "game", params: { code: "K7Q2" } });
    expect(matchRoute("/u/ada_l")).toEqual({ name: "profile", params: { handle: "ada_l" } });
    expect(matchRoute("/replay/K7Q2")).toEqual({ name: "replay", params: { code: "K7Q2" } });
    expect(matchRoute("/games")?.name).toBe("games");
    expect(matchRoute("/ledger")?.name).toBe("ledger");
  });

  it("rejects anything outside the table", () => {
    for (const path of ["/g", "/g/", "/g/a/b", "/u/", "/games/1", "/replay", "/nope", "/g/has space", "/g/<x>", `/g/${"a".repeat(65)}`]) {
      expect(matchRoute(path), path).toBeNull();
    }
  });
});

describe("pathFor", () => {
  it("builds links that match their own route", () => {
    expect(pathFor("home")).toBe("/");
    expect(pathFor("sandbox")).toBe("/sandbox");
    expect(pathFor("game", { code: "K7Q2" })).toBe("/g/K7Q2");
    expect(matchRoute(pathFor("profile", { handle: "ada" }))).toEqual({ name: "profile", params: { handle: "ada" } });
  });
});
