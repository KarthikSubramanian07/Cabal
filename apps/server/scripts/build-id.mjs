// What a deploy stamps on the Worker, so `/health` names the commit that is live (issue #12).
// Pure functions: deploy.mjs asks git and passes the answers in, and build-id.test.mjs checks them.

/** Hex digits of the commit `/health` reports: enough to be unique in this repository, short enough to read. */
export const SHORT = 12;

/**
 * The `BUILD_ID` for a commit: its short hash, with `-dirty` when the working tree had changes that
 * are not in that commit (so a deploy from an uncommitted tree never claims to be the commit).
 */
export function buildIdFor(commit, dirty) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`not a commit hash: ${JSON.stringify(commit)}`);
  return `${commit.slice(0, SHORT)}${dirty ? "-dirty" : ""}`;
}

/**
 * The arguments for `wrangler deploy`: `BUILD_ID` as a plain variable (what `/health` reports as
 * `build`), and the same id as the version's tag with the commit subject as its message, so
 * `wrangler deployments list` and the dashboard name the commit too.
 */
export function deployArgs(buildId, subject, extra = []) {
  // Version messages are capped by Cloudflare; a commit subject almost never comes close.
  const message = subject.replace(/\s+/g, " ").trim().slice(0, 100) || buildId;
  return ["deploy", "--var", `BUILD_ID:${buildId}`, "--tag", buildId, "--message", message, ...extra];
}
