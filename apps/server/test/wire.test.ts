/**
 * The wire contract a client is built against: numbered frames and resume, what a welcome carries,
 * table talk and press history, seals a client can verify, draw votes, order verdicts.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Game, pledgeCommit, pledgeOpens, randomNonce } from "@cabal/engine";
import { type LedgerResponse, PROTOCOL_VERSION, type PressPage, type ReplayExtension, type SeatView, ServerMessage } from "@cabal/protocol";
import { Client, POWERS, create, holdAndReady, inRoom, join, nextIp, sql, start, summary, until } from "./helpers.js";

const get = (path: string, token?: string) =>
  SELF.fetch(`http://cabal${path}`, { headers: { "cf-connecting-ip": nextIp(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

async function twoPlayers(settings: Record<string, unknown> = {}) {
  const ann = await create("Ann", { aiFill: true, readyAdvance: true, ...settings });
  const bob = await join(ann.gameId, "Bob");
  expect((await start(ann)).status).toBe(200);
  const a = await Client.connect(ann.gameId, ann.token);
  const b = await Client.connect(ann.gameId, bob.token);
  const wa = await a.next("welcome");
  const wb = await b.next("welcome");
  return { ann, bob, a, b, wa, wb, annUnits: wa.p.state.units[ann.power]!, bobUnits: wb.p.state.units[bob.power]! };
}

describe("numbered frames and resume", () => {
  it("numbers every broadcast frame with its own seq, strictly increasing, and state and results agree with their envelope", async () => {
    const { a, b, annUnits, bobUnits } = await twoPlayers();
    b.send({ t: "orders.set", p: { phase: "S1901M", orders: bobUnits.map((u) => `${u} H`) } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await holdAndReady(a, annUnits, "S1901M");
    await until(async () => b.has("state"), "the state frame");
    const numbered = b.frames.filter((f) => f.seq !== undefined);
    expect(numbered.length).toBeGreaterThan(3);
    const seqs = numbered.map((f) => f.seq!);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const frame of numbered) {
      // Every frame the server sends validates against the published schema.
      expect(ServerMessage.safeParse(frame).success).toBe(true);
      if (frame.t === "state" || frame.t === "results") expect(frame.p.seq).toBe(frame.seq);
    }
    // Replies to one socket are not part of the sequence.
    expect(b.frames.filter((f) => f.t === "orders.ack").every((f) => f.seq === undefined)).toBe(true);
  });

  it("resumes from a cursor: sync replays exactly the frames after it, each with its seq, and never the cursor's own frame", async () => {
    const { ann, bob, a, b, wb, annUnits, bobUnits } = await twoPlayers();
    // Bob files his orders, readies up and loses his connection before the phase resolves.
    b.send({ t: "orders.set", p: { phase: "S1901M", orders: bobUnits.map((u) => `${u} H`) } });
    await b.next("orders.ack");
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    const cursor = (await b.next("seats", (m) => m.p.seats.find((s) => s.power === bob.power)!.ready)).seq!;
    expect(cursor).toBeGreaterThan(wb.p.seq);
    b.close();
    await until(async () => (await summary(ann.gameId)).seats.find((s) => s.power === bob.power)!.present === false, "Bob to be seen leaving");
    a.send({ t: "press.send", p: { to: "ALL", body: "where is Bob?" } });
    const state = await holdAndReady(a, annUnits, "S1901M");
    expect(state.seq).toBeGreaterThan(cursor);

    const back = await Client.connect(ann.gameId, bob.token);
    const welcome = await back.next("welcome");
    expect(welcome.p.phase).toBe("F1901M");
    expect(welcome.p.seq).toBeGreaterThanOrEqual(state.seq!);
    back.clear();
    back.send({ t: "sync", id: "s1", p: { since: cursor } });
    const synced = await back.next("synced");
    expect(synced.p).toMatchObject({ more: false, gap: false });
    expect(synced.id).toBe("s1");
    const replayed = back.frames.filter((f) => f.seq !== undefined && f.seq <= welcome.p.seq);
    expect(replayed.map((f) => f.t)).toEqual(expect.arrayContaining(["press", "results", "state"]));
    expect(replayed.every((f) => f.seq! > cursor)).toBe(true);
    expect(replayed.map((f) => f.seq)).toEqual(replayed.map((f) => f.seq!).sort((x, y) => x - y));

    // The off-by-one: syncing from a frame's own seq must not hand that frame back.
    back.clear();
    back.send({ t: "sync", p: { since: state.seq! } });
    await back.next("synced");
    expect(back.frames.some((f) => f.t === "state" && f.seq === state.seq)).toBe(false);
    expect(back.frames.filter((f) => f.seq !== undefined).every((f) => f.seq! > state.seq!)).toBe(true);
  });

  it("pages a long replay with more, and reports a gap when the cursor's frames are no longer stored", async () => {
    const ann = await create("Ann");
    const a = await Client.connect(ann.gameId, ann.token);
    const welcome = await a.next("welcome");
    const first = welcome.p.seq;
    await inRoom(ann.gameId, (room) => {
      const last = room.sql.exec<{ n: number | null }>("SELECT MAX(seq) AS n FROM events").one().n ?? 0;
      for (let i = 1; i <= 620; i++) {
        room.sql.exec("INSERT INTO events (seq, audience, payload_json) VALUES (?, 'ALL', ?)", last + i, JSON.stringify({ t: "error", p: { code: "filler", message: String(i) } }));
      }
    });
    a.clear();
    a.send({ t: "sync", p: { since: first } });
    const page1 = await a.next("synced");
    expect(page1.p).toMatchObject({ more: true, gap: false });
    expect(a.frames.filter((f) => f.seq !== undefined)).toHaveLength(500);
    expect(a.frames.at(-1)!.seq).toBe(page1.p.seq);
    a.clear();
    a.send({ t: "sync", p: { since: page1.p.seq } });
    const page2 = await a.next("synced");
    expect(page2.p).toMatchObject({ more: false, gap: false });
    expect(a.frames.filter((f) => f.seq !== undefined)).toHaveLength(120);

    // The oldest frames are pruned: a cursor from before them cannot be resumed.
    await sql(ann.gameId, "DELETE FROM events WHERE seq <= ?", first + 300);
    a.clear();
    a.send({ t: "sync", p: { since: first } });
    expect((await a.next("synced")).p).toMatchObject({ gap: true, more: false, seq: page2.p.seq });
    expect(a.frames.filter((f) => f.seq !== undefined)).toHaveLength(0);
    // So is a cursor from the future.
    a.send({ t: "sync", p: { since: page2.p.seq + 50 } });
    expect((await a.next("synced")).p.gap).toBe(true);
  });

  it("answers the keepalive ping without a frame of its own", async () => {
    const ann = await create("Ann");
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    await a.next("seats"); // the room announcing that Ann is connected
    a.clear();
    a.ws.send("ping");
    await until(async () => a.pongs > 0, "the pong");
    expect(a.frames).toEqual([]);
  });
});

describe("what a welcome carries", () => {
  it("names the host, the clock, the protocol and, per seat, who plays it, who is connected and whose orders are in", async () => {
    const ann = await create("Ann", { aiFill: true });
    const bob = await join(ann.gameId, "Bob");
    const a = await Client.connect(ann.gameId, ann.token);
    const lobby = await a.next("welcome");
    expect(lobby.p).toMatchObject({ protocol: PROTOCOL_VERSION, status: "lobby", host: ann.power, power: ann.power, history: [], finished: null, unread: {}, pressMore: false });
    expect(Math.abs(lobby.p.serverTime - Date.now())).toBeLessThan(5_000);
    const seat = (frame: { p: { seats: SeatView[] } }, power: string) => frame.p.seats.find((s) => s.power === power)!;
    expect(seat(lobby, ann.power)).toMatchObject({ host: true, present: true, submitted: false, canAct: false, brain: null });
    expect(seat(lobby, bob.power)).toMatchObject({ host: false, present: false, kind: "human" });

    // Presence is announced as it changes, to everyone, and is never stored for replay.
    const before = (await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM events"))[0]!.n;
    const b = await Client.connect(ann.gameId, bob.token);
    await b.next("welcome");
    const arrived = await a.next("seats", (m) => seat(m, bob.power).present === true);
    expect(arrived.seq).toBeUndefined();
    expect((await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM events"))[0]!.n).toBe(before);
    b.close();
    await a.next("seats", (m) => seat(m, bob.power).present === false);

    await start(ann);
    const started = await a.next("state");
    expect(started.p).toMatchObject({ status: "active", phase: "S1901M" });
    expect(Math.abs(started.p.serverTime - Date.now())).toBeLessThan(5_000);
    const seats = await a.next("seats", (m) => m.p.seats.some((s) => s.kind === "ai"));
    const ai = seats.p.seats.find((s) => s.kind === "ai")!;
    expect(ai).toMatchObject({ brain: "bot", present: true, submitted: true, ready: true, canAct: true });
    expect(seat(seats, ann.power)).toMatchObject({ submitted: false, canAct: true });

    // Orders in: the table learns that Ann has filed, and nothing about what she filed.
    a.clear();
    const units = started.p.state.units[ann.power]!;
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    const filed = await a.next("seats", (m) => seat(m, ann.power).submitted === true);
    expect(JSON.stringify(filed)).not.toContain(`${units[0]} H`);
    a.send({ t: "orders.default", id: "d1", p: { orders: [`${units[0]} H`, "nonsense"] } });
    const defaults = await a.next("orders.default.ack");
    expect(defaults).toMatchObject({ id: "d1", p: { accepted: [`${units[0]} H`], rejected: [{ text: "nonsense" }] } });

    const again = await Client.connect(ann.gameId, ann.token);
    const welcome = await again.next("welcome");
    expect(welcome.p.orders).toEqual(units.map((u) => `${u} H`));
    expect(welcome.p.defaults).toEqual([`${units[0]} H`]);
    expect(welcome.p.votes).toMatchObject({ phase: "S1901M", draw: [], hidden: false, cast: 0, yes: 0 });
    const spectator = await Client.connect(ann.gameId);
    const watching = await spectator.next("welcome");
    expect(watching.p).toMatchObject({ power: null, orders: [], defaults: [], host: ann.power });
  });

  it("lists every resolved phase with the centres it left, in the welcome, the results frame and the summary", async () => {
    const { ann, a, b, annUnits, bobUnits } = await twoPlayers();
    b.send({ t: "orders.set", p: { phase: "S1901M", orders: bobUnits.map((u) => `${u} H`) } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await holdAndReady(a, annUnits, "S1901M");
    const results = await a.next("results");
    expect(results.p.summary.phase).toBe("S1901M");
    expect(Object.keys(results.p.summary.centers).sort()).toEqual([...POWERS]);
    const s = await summary(ann.gameId);
    expect(s.history).toEqual([results.p.summary]);
    expect(s).toMatchObject({ host: ann.power });
    const welcome = await (await Client.connect(ann.gameId, ann.token)).next("welcome");
    expect(welcome.p.history).toEqual([results.p.summary]);
    // A phase stored before summaries existed is summarised from its outcome.
    await sql(ann.gameId, "UPDATE phases SET summary_json = NULL");
    expect((await summary(ann.gameId)).history[0]!.centers).toEqual(results.p.summary.centers);
  });
});

describe("table talk and press history", () => {
  it("lets seated players talk to the table before the game starts, and nothing else", async () => {
    const ann = await create("Ann", { press: "gunboat" });
    const bob = await join(ann.gameId, "Bob");
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const spectator = await Client.connect(ann.gameId);
    await Promise.all([a.next("welcome"), b.next("welcome"), spectator.next("welcome")]);
    a.send({ t: "press.send", id: "l1", p: { to: "ALL", body: "Shall we wait for a seventh?" } });
    const heard = await b.next("press");
    expect(heard.p).toMatchObject({ phase: "LOBBY", from: ann.power, to: "ALL", pledge: null });
    expect((await a.next("press")).id).toBe("l1");
    expect((await spectator.next("press")).p.body).toContain("seventh");

    b.send({ t: "press.send", p: { to: ann.power, body: "psst" } });
    expect((await b.next("error")).p.code).toBe("lobby_public_only");
    b.send({ t: "press.send", p: { to: "ALL", body: "I swear", pledge: { orders: ["A PAR H"], sealed: false } } });
    expect((await b.next("error")).p.code).toBe("bad_pledge");
    spectator.send({ t: "press.send", p: { to: "ALL", body: "let me in" } });
    expect((await spectator.next("error")).p.code).toBe("spectator");
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    expect((await b.next("error")).p.code).toBe("not_active");

    // The talk is still there after the start, and a gunboat game is then silent.
    await start(ann);
    const welcome = await (await Client.connect(ann.gameId, bob.token)).next("welcome");
    expect(welcome.p.press.map((p) => p.phase)).toEqual(["LOBBY"]);
    expect(welcome.p.unread).toEqual({ ALL: 1 });
    a.send({ t: "press.send", p: { to: "ALL", body: "too late" } });
    expect((await a.next("error")).p.code).toBe("no_press");
  });

  it("pages press history backwards, and keeps private threads to their two powers", async () => {
    const { ann, bob, a, b } = await twoPlayers();
    for (let i = 1; i <= 5; i++) a.send({ t: "press.send", p: { to: "ALL", body: `public ${i}` } });
    a.send({ t: "press.send", p: { to: bob.power, body: "private 1" } });
    await b.next("press", (m) => m.p.body === "private 1");
    b.send({ t: "press.send", p: { to: ann.power, body: "private 2" } });
    await b.next("press", (m) => m.p.body === "private 2");
    await a.next("press", (m) => m.p.body === "private 2");

    const page = async (query: string, token?: string) => (await (await get(`/api/games/${ann.gameId}/press${query}`, token)).json()) as PressPage;
    const newest = await page("?limit=2&with=ALL");
    expect(newest.press.map((p) => p.body)).toEqual(["public 4", "public 5"]);
    expect(newest.more).toBe(true);
    const older = await page(`?limit=2&with=ALL&before=${newest.press[0]!.sentAt}`);
    expect(older.press.map((p) => p.body)).toEqual(["public 2", "public 3"]);
    const oldest = await page(`?limit=2&with=ALL&before=${older.press[0]!.sentAt}`);
    expect(oldest).toMatchObject({ more: false, press: [{ body: "public 1" }] });
    // sentAt is strictly increasing, so a page boundary never splits or repeats a message.
    const all = await page("", ann.token);
    expect(new Set(all.press.map((p) => p.sentAt)).size).toBe(7);

    // Without a token: public press only. A private thread needs one of its two seats.
    expect((await page("")).press.every((p) => p.to === "ALL")).toBe(true);
    expect((await get(`/api/games/${ann.gameId}/press?with=${bob.power}`)).status).toBe(401);
    expect((await page(`?with=${bob.power}`, ann.token)).press.map((p) => p.body)).toEqual(["private 1", "private 2"]);
    const third = POWERS.find((p) => p !== ann.power && p !== bob.power)!;
    expect((await page(`?with=${third}`, ann.token)).press).toEqual([]);
    expect((await get(`/api/games/${ann.gameId}/press?with=NOBODY`)).status).toBe(400);
    expect((await get(`/api/games/${ann.gameId}/press?token=${ann.token}`)).status).toBe(400);
  });

  it("counts unread press per thread from the seat's read markers", async () => {
    const { ann, bob, a, b } = await twoPlayers();
    a.send({ t: "press.send", p: { to: "ALL", body: "one" } });
    a.send({ t: "press.send", p: { to: bob.power, body: "two" } });
    a.send({ t: "press.send", p: { to: bob.power, body: "three" } });
    const last = await b.next("press", (m) => m.p.body === "three");
    const fresh = await (await Client.connect(ann.gameId, bob.token)).next("welcome");
    expect(fresh.p.unread).toEqual({ ALL: 1, [ann.power]: 2 });
    // What you sent yourself is never unread.
    expect((await (await Client.connect(ann.gameId, ann.token)).next("welcome")).p.unread).toEqual({});

    b.send({ t: "press.read", p: { with: ann.power, upTo: last.p.sentAt } });
    expect((await b.next("press.unread")).p.unread).toEqual({ ALL: 1 });
    // A marker never moves backwards.
    b.send({ t: "press.read", p: { with: ann.power, upTo: 1 } });
    expect((await b.next("press.unread")).p.unread).toEqual({ ALL: 1 });
    a.send({ t: "press.send", p: { to: bob.power, body: "four" } });
    await b.next("press", (m) => m.p.body === "four");
    expect((await (await Client.connect(ann.gameId, bob.token)).next("welcome")).p.unread).toEqual({ ALL: 1, [ann.power]: 1 });
  });
});

describe("seals a client can verify", () => {
  it("reveals the nonce with the receipt, so the audience can open the commitment itself", async () => {
    const { ann, bob, a, b, annUnits, bobUnits } = await twoPlayers();
    const pledged = [`${annUnits[0]} H`];
    const nonce = randomNonce();
    const commitment = pledgeCommit(pledged, nonce);

    // A commitment that does not match what was sent is refused: the server seals exactly what it is given.
    a.send({ t: "press.send", p: { to: bob.power, body: "trust me", pledge: { orders: pledged, sealed: true, nonce, commitment: "0".repeat(64) } } });
    expect((await a.next("error")).p.code).toBe("bad_pledge");

    a.send({ t: "press.send", p: { to: bob.power, body: "I hold", pledge: { orders: pledged, sealed: true, nonce, commitment } } });
    const atBob = await b.next("press");
    expect(atBob.p.pledge).toMatchObject({ commitment, orders: null, nonce: null, receipt: null });
    const atAnn = await a.next("press");
    expect(atAnn.p.pledge).toMatchObject({ commitment, orders: pledged, nonce });
    // Nothing on the wire to Bob can open the seal yet.
    expect(JSON.stringify(b.frames)).not.toContain(nonce);

    // A public pledge with a nonce the server picked: the pledger is told it at once.
    a.send({ t: "press.send", p: { to: "ALL", body: "to all: I hold", pledge: { orders: pledged, sealed: true } } });
    const mine = await a.next("press", (m) => m.p.to === "ALL");
    expect(mine.p.pledge!.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(pledgeOpens(mine.p.pledge!.commitment, pledged, mine.p.pledge!.nonce!)).toBe(true);
    expect((await b.next("press", (m) => m.p.to === "ALL")).p.pledge).toMatchObject({ orders: null, nonce: null });

    // Before the phase resolves the ledger lists nothing, to anyone.
    const ledger = async (token?: string) => (await (await get(`/api/games/${ann.gameId}/ledger`, token)).json()) as LedgerResponse;
    expect((await ledger(ann.token)).entries).toEqual([]);

    b.send({ t: "orders.set", p: { phase: "S1901M", orders: bobUnits.map((u) => `${u} H`) } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    await holdAndReady(a, annUnits, "S1901M");
    const receipt = await b.next("pledge.receipt", (m) => m.p.pledgeId === atBob.p.pledge!.id);
    expect(receipt.p).toMatchObject({ receipt: "kept", revealed: pledged, nonce });
    expect(pledgeOpens(atBob.p.pledge!.commitment, receipt.p.revealed!, receipt.p.nonce)).toBe(true);
    expect(pledgeOpens(atBob.p.pledge!.commitment, [`${annUnits[0]} - PAR`], receipt.p.nonce)).toBe(false);

    // The ledger: public pledges for anyone, private ones for their two powers, each one checkable.
    const anonymous = await ledger();
    expect(anonymous.ledger[ann.power]).toEqual({ kept: 2, broken: 0, void: 0 });
    expect(anonymous.entries.map((e) => e.audience)).toEqual(["ALL"]);
    const third = (await summary(ann.gameId)).seats.find((s) => s.kind === "ai")!.power;
    expect((await ledger(bob.token)).entries.map((e) => e.audience).sort()).toEqual(["ALL", bob.power].sort());
    expect((await ledger(ann.token)).entries).toHaveLength(2);
    for (const entry of (await ledger(ann.token)).entries) {
      expect(entry.receipt).toBe("kept");
      expect(pledgeOpens(entry.commitment, entry.orders, entry.nonce)).toBe(true);
    }
    expect(third).not.toBe(bob.power);

    // The replay is still a MILA saved game, and now carries the pledges and receipts too.
    const replay = (await (await get(`/api/games/${ann.gameId}/replay`, bob.token)).json()) as { phases: { name: string }[]; cabal: ReplayExtension };
    expect(replay.phases.map((p) => p.name)).toEqual(["S1901M", "F1901M"]);
    expect(replay.cabal.pledges).toHaveLength(2);
    expect(replay.cabal.history.map((h) => h.phase)).toEqual(["S1901M"]);
    expect(Game.fromSaved(JSON.stringify(replay)).phase()).toBe("F1901M");
    const publicReplay = (await (await get(`/api/games/${ann.gameId}/replay`)).json()) as { cabal: ReplayExtension };
    expect(publicReplay.cabal.pledges.map((p) => p.audience)).toEqual(["ALL"]);

    // Once the game is over the whole ledger is open to audit.
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    await a.next("finished");
    expect((await ledger()).entries).toHaveLength(2);
    // A reconnecting audience member sees the pledge resolved, with its nonce.
    const later = await (await Client.connect(ann.gameId, bob.token)).next("welcome");
    expect(later.p.press.find((p) => p.pledge?.id === atBob.p.pledge!.id)!.pledge).toMatchObject({ receipt: "kept", nonce, orders: pledged });
    expect(later.p.finished).toMatchObject({ result: "draw", reason: "vote" });
  });

  it("replays a sealed pledge to its pledger with the orders, and to nobody else", async () => {
    const { ann, bob, a, b, annUnits } = await twoPlayers();
    a.send({ t: "press.send", p: { to: "ALL", body: "sealed", pledge: { orders: [`${annUnits[0]} H`], sealed: true } } });
    await b.next("press");
    for (const [seat, sees] of [[ann, true], [bob, false]] as const) {
      const c = await Client.connect(ann.gameId, seat.token);
      await c.next("welcome");
      c.clear();
      c.send({ t: "sync", p: { since: 0 } });
      await c.next("synced");
      const press = c.frames.find((f) => f.t === "press") as Extract<ServerMessage, { t: "press" }>;
      expect(press.p.pledge!.orders === null).toBe(!sees);
      expect(press.p.pledge!.nonce === null).toBe(!sees);
    }
  });
});

describe("draw votes", () => {
  it("shows who voted when votes are public", async () => {
    const { ann, a, b } = await twoPlayers({ publicVotes: true });
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    const votes = await b.next("votes");
    expect(votes.p).toMatchObject({ hidden: false, cast: 1, yes: 1, draw: [{ power: ann.power, value: true }] });
    expect(votes.seq).toBeGreaterThan(0);
  });

  it("hides who voted when the game says so: the table sees the tally, a voter sees their own ballot", async () => {
    const { ann, bob, a, b } = await twoPlayers({ publicVotes: false });
    const spectator = await Client.connect(ann.gameId);
    await spectator.next("welcome");
    a.send({ t: "vote", p: { kind: "draw", value: true } });
    const atBob = await b.next("votes");
    expect(atBob.p).toMatchObject({ hidden: true, cast: 1, yes: 1, draw: [] });
    expect((await spectator.next("votes")).p.draw).toEqual([]);
    const atAnn = await a.next("votes", (m) => m.p.draw.length === 1);
    expect(atAnn.p.draw).toEqual([{ power: ann.power, value: true, include: null }]);
    expect(JSON.stringify(b.frames)).not.toContain(`"power":"${ann.power}","value":true`);
    // A welcome keeps the same secret.
    const bobAgain = await (await Client.connect(ann.gameId, bob.token)).next("welcome");
    expect(bobAgain.p.votes).toMatchObject({ hidden: true, cast: 1, yes: 1, draw: [] });
    const annAgain = await (await Client.connect(ann.gameId, ann.token)).next("welcome");
    expect(annAgain.p.votes.draw).toHaveLength(1);
    // And the vote still works.
    b.send({ t: "vote", p: { kind: "draw", value: true } });
    expect((await a.next("finished")).p).toMatchObject({ result: "draw", reason: "vote" });
  });
});

describe("order verdicts", () => {
  it("judges every order against the board and files only the legal ones", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const state = new Game().state();
    const enemy = POWERS.find((p) => p !== ann.power)!;
    state.units = { [ann.power]: ["A PAR", "F BRE"], [enemy]: ["A MUN"] };
    await inRoom(ann.gameId, async (room, storage) => {
      const game = Game.fromState(state);
      (room as unknown as { game: Game }).game = game;
      await storage.storage.put("saved", game.toSaved(ann.gameId));
    });
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    a.send({
      t: "orders.set",
      id: "o1",
      p: { phase: "S1901M", orders: ["A PAR - MOS", "A PAR - BUR", "A MUN - BUR", "F BRE flies to the moon", "A PAR - PIC", "F BRE - MAO", "A ROM H"] },
    });
    const ack = await a.next("orders.ack");
    expect(ack.id).toBe("o1");
    expect(ack.p.verdicts.map((v) => [v.text, v.ok, v.code])).toEqual([
      ["A PAR - MOS", false, "illegal"],
      ["A PAR - BUR", false, "superseded"],
      ["A MUN - BUR", false, "no_such_unit"],
      ["F BRE flies to the moon", false, "syntax"],
      ["A PAR - PIC", true, "ok"],
      ["F BRE - MAO", true, "ok"],
      ["A ROM H", false, "no_such_unit"],
    ]);
    expect(ack.p.accepted).toEqual(["A PAR - PIC", "F BRE - MAO"]);
    expect(ack.p.rejected.map((r) => r.text)).toEqual(["A PAR - MOS", "A PAR - BUR", "A MUN - BUR", "F BRE flies to the moon", "A ROM H"]);
    expect(ack.p.verdicts.every((v) => v.ok || v.reason.length > 0)).toBe(true);
    expect(await sql<{ orders_json: string }>(ann.gameId, "SELECT orders_json FROM orders WHERE power = ? AND phase = 'S1901M'", ann.power)).toEqual([
      { orders_json: JSON.stringify(["A PAR - PIC", "F BRE - MAO"]) },
    ]);
    // An order that names another power is refused as such.
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: [`${enemy}: A MUN - BUR`] } });
    expect((await a.next("orders.ack")).p.verdicts[0]).toMatchObject({ ok: false, code: "foreign_power" });
  });

  it("never files more builds than the allowance, nor two in one province", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const state = new Game().state();
    state.name = "F1901M";
    // Two armies away from home: every home centre is free, and there are more of them than builds.
    state.units[ann.power] = ["A SIL", "A BOH"];
    const staged = Game.fromState(state);
    staged.process({ orders: {} });
    expect(staged.phase()).toBe("W1901A");
    const legal = staged.legal(ann.power);
    const menu = Object.values(legal.by_unit).flat().filter((o) => o.endsWith(" B"));
    const province = (order: string) => order.slice(2, 5);
    const distinct = menu.filter((o, i) => menu.findIndex((x) => province(x) === province(o)) === i);
    expect(legal.allowance).toBeGreaterThanOrEqual(1);
    expect(distinct.length).toBeGreaterThan(legal.allowance);
    await inRoom(ann.gameId, async (room, storage) => {
      (room as unknown as { game: Game }).game = staged;
      await storage.storage.put("saved", staged.toSaved(ann.gameId));
    });
    const a = await Client.connect(ann.gameId, ann.token);
    await a.next("welcome");
    const twice = menu.find((o) => o !== distinct[0] && province(o) === province(distinct[0]!));
    a.send({ t: "orders.set", p: { phase: "W1901A", orders: [...(twice ? [twice] : []), ...distinct] } });
    const ack = await a.next("orders.ack");
    expect(ack.p.accepted).toHaveLength(legal.allowance);
    expect(new Set(ack.p.accepted.map(province)).size).toBe(legal.allowance);
    if (twice) expect(ack.p.verdicts[0]).toMatchObject({ ok: false, code: "superseded" });
    expect(ack.p.verdicts.filter((v) => v.code === "over_allowance")).toHaveLength(distinct.length - legal.allowance);
  });
});
