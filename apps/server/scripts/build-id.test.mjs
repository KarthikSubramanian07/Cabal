import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIdFor, deployArgs } from "./build-id.mjs";

const SHA = "3b30e06c5d9a1f2e4b6c8d0a1b2c3d4e5f607182";

test("a clean tree deploys as its twelve character commit", () => {
  assert.equal(buildIdFor(SHA, false), "3b30e06c5d9a");
});

test("a tree with uncommitted changes never claims to be the commit", () => {
  assert.equal(buildIdFor(SHA, true), "3b30e06c5d9a-dirty");
});

test("anything that is not a commit hash is refused", () => {
  assert.throws(() => buildIdFor("", false));
  assert.throws(() => buildIdFor("main", false));
  assert.throws(() => buildIdFor("3b30e06; rm -rf /", false));
});

test("wrangler gets the id as a variable, a tag and a one line message", () => {
  assert.deepEqual(deployArgs("3b30e06c5d9a", "feat(server): a thing\n\nwith a body"), [
    "deploy",
    "--var",
    "BUILD_ID:3b30e06c5d9a",
    "--tag",
    "3b30e06c5d9a",
    "--message",
    "feat(server): a thing with a body",
  ]);
});

test("a long subject is cut, an empty one falls back to the id, extra arguments pass through", () => {
  assert.equal(deployArgs("abc1234", "x".repeat(300))[6].length, 100);
  assert.equal(deployArgs("abc1234", "  ")[6], "abc1234");
  assert.deepEqual(deployArgs("abc1234", "s", ["--dry-run"]).slice(-1), ["--dry-run"]);
});
