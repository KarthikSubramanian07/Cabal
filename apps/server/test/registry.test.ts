import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type GameRecord, GameSettings } from "@cabal/protocol";
import { MIGRATIONS, type Registry } from "../src/registry.js";
import { Client, create, fireAlarm, inRoom, index, join, registry, serverEnv, sleep, start, summary, until, untilIndexed } from "./helpers.js";

const record = (gameId: string, over: Partial<GameRecord> = {}): GameRecord => ({
  gameId,
  result: "draw",
  reason: "vote",
  winners: ["FRANCE", "ITALY"],
  scores: { FRANCE: 0.5, ITALY: 0.5 },
  settings: GameSettings.parse({}),
  cluster: "standard:full:async",
  phaseCount: 12,
  createdAt: 1_000,
  finishedAt: 2_000,
  ledger: { FRANCE: { kept: 2, broken: 1, void: 0 } },
  seats: [{ power: "FRANCE", kind: "human", name: "Ann", centers: 9, eliminated: false }],
  ...over,
});

describe("Registry", () => {
  it("brings its schema up through every in-object migration, starting from the games index", async () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(MIGRATIONS[0]!.name).toBe("games_index");
    expect(await registry().schemaVersion()).toBe(MIGRATIONS.at(-1)!.version);
    await runInDurableObject(registry(), (_instance: Registry, state) => {
      const applied = state.storage.sql.exec<{ version: number; name: string }>("SELECT version, name FROM _migrations ORDER BY version").toArray();
      expect(applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
      const columns = state.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('games_index')").toArray().map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining(["game_id", "result", "winners_json", "scores_json", "settings_json", "phase_count", "finished_at", "ledger_json", "reason", "cluster", "created_at", "seats_json", "public"]),
      );
      // The table's own constraint admits abandoned games and nothing invented.
      expect(() => state.storage.sql.exec("INSERT INTO games_index (game_id, result, winners_json, scores_json, settings_json, phase_count, finished_at, ledger_json) VALUES ('BADBAD', 'cancelled', '[]', '{}', '{}', 0, 0, '{}')")).toThrow();
    });
  });

  it("records a game idempotently and reads it back", async () => {
    await registry().recordGame(record("RECAAA"));
    await registry().recordGame(record("RECAAA", { phaseCount: 13 }));
    expect(await registry().getGame("RECAAA")).toEqual(record("RECAAA", { phaseCount: 13 }));
    expect(await registry().getGame("NOSUCH")).toBeNull();
    // A record that does not validate is refused before it reaches the table.
    await runInDurableObject(registry(), (instance: Registry) => {
      expect(() => instance.recordGame({ ...record("RECBAD"), result: "cancelled" as never })).toThrow();
    });
    expect(await registry().getGame("RECBAD")).toBeNull();
  });

  it("lists the most recently ended games first, pages by time and filters by result", async () => {
    const far = 9_000_000_000_000;
    const settings = GameSettings.parse({ visibility: "public" });
    await registry().recordGame(record("LISTA1", { finishedAt: far + 1, settings }));
    await registry().recordGame(record("LISTA2", { finishedAt: far + 2, result: "abandoned", reason: "no_orders", winners: [], scores: {}, settings }));
    await registry().recordGame(record("LISTA3", { finishedAt: far + 3, result: "solo", winners: ["FRANCE"], settings }));
    // Recorded, but never listed: an unlisted game, and a public one that ended before a phase was played.
    await registry().recordGame(record("LISTA4", { finishedAt: far + 4 }));
    await registry().recordGame(record("LISTA5", { finishedAt: far + 5, settings, phaseCount: 0 }));
    expect((await registry().getGame("LISTA4"))?.gameId).toBe("LISTA4");
    expect((await registry().listGames({ limit: 3 })).map((g) => g.gameId)).toEqual(["LISTA3", "LISTA2", "LISTA1"]);
    expect((await registry().listGames({ limit: 2, before: far + 3 })).map((g) => g.gameId)).toEqual(["LISTA2", "LISTA1"]);
    expect((await registry().listGames({ limit: 5, result: "abandoned" }))[0]!.gameId).toBe("LISTA2");
  });
});

/** A D1 database whose every write fails the way `fail` says. */
const failingDb = (fail: () => Promise<never>) =>
  ({ prepare: () => ({ bind: () => ({}) }), batch: fail }) as unknown as D1Database;

describe("hand-off from a room", () => {
  async function drawnGame() {
    const ann = await create("Ann", { aiFill: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    await a.next("welcome");
    await b.next("welcome");
    return { ann, bob, a, b };
  }
  const outbox = (gameId: string) => inRoom(gameId, (room) => room.kv.get<{ attempts: number; nextAt: number; gaveUp?: boolean }>("registry-outbox"));

  it("hands a finished game to the index and then clears its outbox and its alarm", async () => {
    const { ann, a, b } = await drawnGame();
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    await a.next("finished");
    const indexed = await untilIndexed(ann.gameId);
    expect(indexed).toMatchObject({ gameId: ann.gameId, result: "draw", reason: "vote", phaseCount: 0 });
    expect(indexed.winners).toHaveLength(7);
    expect(indexed.seats).toHaveLength(7);
    expect(indexed.finishedAt).toBeGreaterThan(indexed.createdAt - 1);
    await until(async () => (await outbox(ann.gameId)) === undefined, "the outbox to clear");
    await until(async () => (await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())) === null, "the alarm to clear");
  });

  it("C3: an index that is down never delays the finished frame, and the hand-off backs off and then lands", async () => {
    const { ann, a, b } = await drawnGame();
    let calls = 0;
    // The index hangs for seconds on the first call, and fails every time.
    await inRoom(ann.gameId, (room) => {
      room.env = {
        ...room.env,
        DB: failingDb(async () => {
          calls++;
          if (calls === 1) await sleep(3_000);
          throw new Error("index unavailable");
        }),
      };
    });
    const asked = Date.now();
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await a.next("finished")).p.result).toBe("draw");
    // The broadcast did not wait for the hand-off.
    expect(Date.now() - asked).toBeLessThan(2_000);
    expect((await summary(ann.gameId)).status).toBe("finished");

    const first = await until(async () => {
      const entry = await outbox(ann.gameId);
      return entry && entry.attempts === 1 ? entry : null;
    }, "the first failed hand-off");
    expect(calls).toBe(1);
    expect(first.nextAt - Date.now()).toBeGreaterThan(5_000);
    expect(first.nextAt - Date.now()).toBeLessThanOrEqual(10_000);
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBe(first.nextAt);
    // Each failure waits twice as long as the last.
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await inRoom(ann.gameId, (room) => {
        room.outboxAt = Date.now() - 1;
      });
      await fireAlarm(ann.gameId);
      const entry = (await outbox(ann.gameId))!;
      waits.push(entry.nextAt - Date.now());
    }
    for (const [i, want] of [20_000, 40_000, 80_000].entries()) {
      expect(waits[i]).toBeLessThanOrEqual(want);
      expect(waits[i]).toBeGreaterThan(want - 4_000);
    }
    expect(await index().getGame(ann.gameId)).toBeNull();

    // The index comes back. The next attempt delivers the record and the room goes quiet.
    await inRoom(ann.gameId, (room) => {
      room.env = { ...room.env, DB: serverEnv.DB! };
      room.outboxAt = Date.now() - 1;
    });
    await fireAlarm(ann.gameId);
    expect(await untilIndexed(ann.gameId)).toMatchObject({ result: "draw" });
    expect(await outbox(ann.gameId)).toBeUndefined();
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBeNull();
  });

  it("caps the backoff at an hour and stops after its last attempt, keeping the record", async () => {
    const { ann, a, b } = await drawnGame();
    await inRoom(ann.gameId, (room) => {
      room.env = {
        ...room.env,
        DB: failingDb(async () => Promise.reject(new Error("down"))),
      };
    });
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    await a.next("finished");
    await until(async () => ((await outbox(ann.gameId))?.attempts ?? 0) >= 1, "the first failed hand-off");
    const attempt = async (attempts: number) => {
      await inRoom(ann.gameId, (room) => {
        const entry = room.kv.get<Record<string, unknown>>("registry-outbox")!;
        room.kv.put("registry-outbox", { ...entry, attempts });
        room.outboxAt = Date.now() - 1;
      });
      await fireAlarm(ann.gameId);
    };
    await attempt(20);
    const capped = (await outbox(ann.gameId))!;
    expect(capped.attempts).toBe(21);
    expect(capped.nextAt - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(capped.nextAt - Date.now()).toBeGreaterThan(3_590_000);
    await attempt(39);
    const last = (await outbox(ann.gameId))!;
    expect(last).toMatchObject({ attempts: 40, gaveUp: true });
    expect(await inRoom(ann.gameId, (_room, state) => state.storage.getAlarm())).toBeNull();
  });
});
