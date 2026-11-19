/**
 * docs/PROTOCOL.md is the contract a client author reads. This suite fails when it stops agreeing
 * with the schemas in this package or with what the server actually sends.
 */
import { describe, expect, it } from "vitest";
import doc from "../../../docs/PROTOCOL.md?raw";
import router from "../../../apps/server/src/index.ts?raw";
import room from "../../../apps/server/src/room.ts?raw";
import judge from "../../../apps/server/src/validate.ts?raw";
import {
  ClientMessage,
  GameListing,
  GameRecord,
  GameSettings,
  GameSummary,
  HealthResponse,
  LeaderboardResponse,
  LedgerEntry,
  LedgerResponse,
  MeResponse,
  MetricLine,
  MetricsSummary,
  MyGame,
  NotificationPreferences,
  NotificationsResponse,
  PlayerProfile,
  PlayerResult,
  RatingView,
  ReliabilityView,
  TrustLeaderboardResponse,
  TrustView,
  PROTOCOL_VERSION,
  PressPage,
  PushPayload,
  PushSubscriptionRequest,
  ReplayExtension,
  SeatView,
  ServerMessage,
  VotesView,
} from "./index.js";

/** The body of a `## heading` section. */
function section(heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThan(-1);
  const end = doc.indexOf("\n## ", start + 4);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** Rows of the first markdown table in `text`, as cells with backticks kept. */
function table(text: string): string[][] {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("|---"));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 1)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

/** `{ a, b?, c }` -> ["a", "b", "c"], top level only. */
function keys(braced: string): string[] {
  const inner = /\{([^{}]*)\}/.exec(braced)?.[1] ?? "";
  return inner.split(",").map((k) => k.trim().replace(/\?$/, "")).filter(Boolean).sort();
}

const code = (cell: string) => cell.replace(/`/g, "");
const shapeKeys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

function frames(union: { options: readonly unknown[] }): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const option of union.options as { shape: { t: { value: string }; p: { shape: Record<string, unknown> } } }[]) {
    out.set(option.shape.t.value, shapeKeys(option.shape.p));
  }
  return out;
}

describe("docs/PROTOCOL.md", () => {
  it("states the protocol version", () => {
    expect(doc).toContain(`\`PROTOCOL_VERSION\` is ${PROTOCOL_VERSION}.`);
  });

  it("lists every client frame with exactly the payload keys of its schema", () => {
    const documented = new Map(table(section("Client to server")).map((row) => [code(row[0]!), keys(row[1]!)]));
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(frames(ClientMessage)));
  });

  it("lists every server frame with exactly the payload keys of its schema", () => {
    const documented = new Map(table(section("Server to client")).map((row) => [code(row[0]!), keys(row[1]!)]));
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(frames(ServerMessage)));
  });

  it("describes every field of the welcome", () => {
    const text = section("Server to client");
    const rows = table(text.slice(text.indexOf("### The welcome")));
    const described = rows.flatMap((row) => row[0]!.split(",").map((cell) => code(cell.trim()))).sort();
    expect(described).toEqual(frames(ServerMessage).get("welcome"));
  });

  it("lists every setting with its default", () => {
    const rows = table(section("Settings"));
    expect(rows.map((row) => code(row[0]!)).sort()).toEqual(shapeKeys(GameSettings));
    const defaults = GameSettings.parse({}) as Record<string, unknown>;
    for (const row of rows) {
      const name = code(row[0]!);
      const documented = code(row[2]!);
      if (documented === "preset") continue;
      expect(String(defaults[name]), `default of ${name}`).toBe(documented);
    }
  });

  it("lists every seat field and every part of the votes frame", () => {
    const seats = section("Seats");
    expect(keys(seats)).toEqual(shapeKeys(SeatView));
    for (const key of shapeKeys(SeatView).filter((k) => !["power", "kind", "name"].includes(k))) expect(seats).toContain(`| \`${key}\` |`);
    expect(keys(/`votes` is `(\{[^}]*\})`/.exec(section("Draws"))![1]!)).toEqual(shapeKeys(VotesView));
  });

  it("documents every HTTP route the router serves, and the shape of each answer", () => {
    const http = section("HTTP");
    const actions = /GAME_PATH = .*?\(\?:\\\/\(([a-z|]+)\)\)/.exec(router)![1]!.split("|");
    expect(actions.length).toBeGreaterThan(5);
    for (const action of actions) expect(http, action).toContain(`/api/games/:id/${action}\``);
    for (const route of ["`POST /api/games`", "`GET /api/games`", "`GET /api/games/:id`", "`GET /health`"]) expect(http).toContain(route);
    const row = (path: string) => table(http).find((cells) => cells[0] === path)![1]!;
    expect(keys(row("`GET /api/games/:id`"))).toEqual(shapeKeys(GameSummary));
    expect(keys(row("`GET /health`"))).toEqual(shapeKeys(HealthResponse));
    expect(keys(row("`GET /api/games/:id/press`"))).toEqual(shapeKeys(PressPage));
    expect(keys(/`cabal`: `(\{[^}]*\})`/.exec(row("`GET /api/games/:id/replay`"))![1]!)).toEqual(shapeKeys(ReplayExtension));
    const ledger = row("`GET /api/games/:id/ledger`");
    expect(keys(ledger)).toEqual(shapeKeys(LedgerResponse));
    expect(keys(ledger.slice(ledger.indexOf("as `")))).toEqual(shapeKeys(LedgerEntry));
    expect(keys(/A listing from .*? is `(\{[^}]*\})`/.exec(http)![1]!)).toEqual(shapeKeys(GameListing));
    expect(keys(/A finished game is `(\{[^}]*\})`/.exec(http)![1]!)).toEqual(shapeKeys(GameRecord));
  });

  it("documents every player route and the shape of a profile, the boards and a player's games", () => {
    const http = section("HTTP");
    for (const route of ["`POST /api/players`", "`POST /api/players/recover`", "`GET /api/players/:handle`", "`GET /api/me`", "`PATCH /api/me`", "`POST /api/me/recovery`", "`POST /api/me/logout`", "`GET /api/me/games`", "`GET /api/leaderboard`", "`GET /api/ledger`"]) {
      expect(http, route).toContain(route);
    }
    const row = (path: string) => table(http).find((cells) => cells[0] === path)![1]!;
    expect(keys(row("`GET /api/leaderboard`"))).toEqual(shapeKeys(LeaderboardResponse));
    expect(keys(row("`GET /api/leaderboard`").slice(row("`GET /api/leaderboard`").indexOf("each")))).toEqual(shapeKeys(LeaderboardResponse.shape.entries.element));
    expect(keys(row("`GET /api/ledger`"))).toEqual(shapeKeys(TrustLeaderboardResponse));
    expect(keys(row("`GET /api/me/games`").slice(row("`GET /api/me/games`").indexOf(" as ")))).toEqual(shapeKeys(MyGame));
    const players = section("Players");
    expect(keys(/is `(\{[^}]*\})`:/.exec(players)![1]!)).toEqual(shapeKeys(PlayerProfile));
    const fields = table(players).map((cells) => code(cells[0]!)).sort();
    expect(fields).toEqual(shapeKeys(PlayerProfile));
    const cell = (name: string) => table(players).find((cells) => code(cells[0]!) === name)![1]!;
    expect(keys(cell("rating"))).toEqual(shapeKeys(RatingView));
    expect(keys(cell("reliability"))).toEqual(shapeKeys(ReliabilityView));
    expect(keys(cell("trust"))).toEqual(shapeKeys(TrustView));
    expect(keys(cell("recent"))).toEqual(shapeKeys(PlayerResult));
    expect(keys(/plus `account: (\{[^}]*\})`/.exec(row("`GET /api/me`"))![1]!)).toEqual(shapeKeys(MeResponse.shape.account));
  });

  it("documents push, notification switches and the metrics routes, and the shape of each", () => {
    const http = section("HTTP");
    for (const route of ["`GET /api/push/key`", "`POST /api/me/push`", "`DELETE /api/me/push`", "`GET /api/me/notifications`", "`PATCH /api/me/notifications`", "`POST /api/metrics`", "`GET /api/metrics`", "`POST /api/metrics/datc`"]) {
      expect(http, route).toContain(route);
    }
    const row = (path: string) => table(http).find((cells) => cells[0] === path)![1]!;
    expect(keys(row("`POST /api/me/push`"))).toEqual(shapeKeys(PushSubscriptionRequest));
    expect(keys(row("`GET /api/me/notifications`"))).toEqual(shapeKeys(NotificationsResponse));
    expect(keys(row("`PATCH /api/me/notifications`"))).toEqual(shapeKeys(NotificationPreferences));
    expect(keys(row("`GET /api/metrics`"))).toEqual(shapeKeys(MetricsSummary));
    expect(keys(row("`GET /api/metrics`").slice(row("`GET /api/metrics`").indexOf("each metric")))).toEqual(shapeKeys(MetricLine));
    const notifications = section("Notifications");
    expect(table(notifications).map((cells) => code(cells[0]!)).sort()).toEqual(shapeKeys(NotificationPreferences));
    expect(keys(/decrypts to `(\{[^}]*\})`/.exec(notifications)![1]!)).toEqual(shapeKeys(PushPayload));
  });

  it("lists exactly the error codes the room sends and the verdict codes the judge gives", () => {
    const sent = new Set([...room.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]!));
    // Reported to the Claude consumer over the private binding; never sent to a client.
    sent.delete("bad_message");
    const line = /Error codes: (.*)\n/.exec(doc)![1]!;
    const documented = new Set([...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    expect([...documented].sort()).toEqual([...sent].sort());

    const verdicts = new Set([...judge.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]!));
    const listed = table(section("Orders")).map((row) => code(row[0]!));
    expect(listed.sort()).toEqual([...verdicts].sort());
  });

  it("never mentions a frame or field that no longer exists", () => {
    for (const gone of ["pledge.verdict", "`verdict`", "explanations"]) expect(doc).not.toContain(gone);
  });
});
