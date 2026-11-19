/**
 * Security regression tests, ported from the proof-of-concept probes of the security review
 * (its findings C1, H1, H3, H4, M1, M4 and the join race).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, POWERS, create, join, nextIp, sleep, sql, start, summary } from "./helpers.js";

describe("privacy", () => {
  it("never delivers private press to a third power or a spectator: live, in a welcome, or through sync", async () => {
    const ann = await create("Ann", { aiFill: true });
    const bob = await join(ann.gameId, "Bob");
    const cal = await join(ann.gameId, "Cal");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const c = await Client.connect(ann.gameId, cal.token);
    const sp = await Client.connect(ann.gameId);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    await c.next("welcome");
    await sp.next("welcome");
    a.send({ t: "press.send", p: { to: bob.power, body: "SECRET-XYZ" } });
    a.send({ t: "press.send", p: { to: bob.power, body: "SECRET-XYZ sealed", pledge: { orders: [`${units[0]} H`], sealed: true } } });
    await a.next("press", (m) => m.p.pledge !== null);
    c.send({ t: "sync", p: { since: 0 } });
    sp.send({ t: "sync", p: { since: 0 } });
    await c.next("synced");
    await sp.next("synced");
    const c2 = await Client.connect(ann.gameId, cal.token);
    const sp2 = await Client.connect(ann.gameId);
    const b = await Client.connect(ann.gameId, bob.token);
    const bobWelcome = await b.next("welcome");
    await c2.next("welcome");
    await sp2.next("welcome");
    const leak = (x: unknown) => JSON.stringify(x).includes("SECRET-XYZ");
    expect([leak(c.frames), leak(sp.frames), leak(c2.frames), leak(sp2.frames)]).toEqual([false, false, false, false]);
    expect(leak(bobWelcome)).toBe(true);
    // The recipient sees the seal, not the sealed orders.
    const sealed = bobWelcome.p.press.find((m) => m.pledge)!;
    expect(sealed.pledge).toMatchObject({ sealed: true, orders: null });
    // A socket that has not said hello is a spectator and is told nothing private either.
    expect(leak((await Client.connect(ann.gameId)).frames)).toBe(false);
  });

  it("keeps a private pledge receipt between the pledger and its audience", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const sp = await Client.connect(ann.gameId);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    await b.next("welcome");
    await sp.next("welcome");
    a.send({ t: "press.send", p: { to: bob.power, body: "sealed", pledge: { orders: [`${units[0]} H`], sealed: true } } });
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    a.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    b.send({ t: "ready", p: { phase: "S1901M", ready: true } });
    expect((await b.next("pledge.receipt")).p.receipt).toBe("kept");
    // The pledger gets exactly one copy, the spectator none.
    await a.next("state", (m) => m.p.phase === "F1901M");
    expect(a.frames.filter((m) => m.t === "pledge.receipt")).toHaveLength(1);
    await sp.next("state", (m) => m.p.phase === "F1901M");
    expect(sp.has("pledge.receipt")).toBe(false);
  });
});

describe("pledges", () => {
  it("only accepts a pledge about the pledger's own units and orders they can really be given", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const b = await Client.connect(ann.gameId, bob.token);
    const mine = (await a.next("welcome")).p.state.units[ann.power]!;
    const theirs = (await b.next("welcome")).p.state.units[bob.power]!;
    // A promise about somebody else's unit could never be broken, so it would farm a clean ledger.
    a.send({ t: "press.send", id: "foreign", p: { to: "ALL", body: "I hold.", pledge: { orders: [`${theirs[0]} H`], sealed: false } } });
    expect(await a.next("error", (m) => m.id === "foreign")).toMatchObject({ p: { code: "bad_pledge" } });
    // Naming it under the pledger's own power does not help.
    a.send({ t: "press.send", id: "prefixed", p: { to: "ALL", body: "I hold.", pledge: { orders: [`${ann.power}: ${theirs[0]} H`], sealed: false } } });
    expect(await a.next("error", (m) => m.id === "prefixed")).toMatchObject({ p: { code: "bad_pledge" } });
    // Nor does an order the unit cannot be given, or one for a unit that does not exist.
    a.send({ t: "press.send", id: "impossible", p: { to: "ALL", body: "I go.", pledge: { orders: [`${mine[0]} - ${mine[0]!.slice(2, 5) === "MOS" ? "PAR" : "MOS"}`], sealed: true } } });
    expect(await a.next("error", (m) => m.id === "impossible")).toMatchObject({ p: { code: "bad_pledge" } });
    a.send({ t: "press.send", id: "mixed", p: { to: bob.power, body: "Both.", pledge: { orders: [`${mine[0]} H`, `${theirs[0]} H`], sealed: false } } });
    expect(await a.next("error", (m) => m.id === "mixed")).toMatchObject({ p: { code: "bad_pledge" } });
    // A refused pledge leaves nothing behind: no pledge, and no message carrying it.
    expect(await sql(ann.gameId, "SELECT id FROM pledges")).toHaveLength(0);
    expect(await sql(ann.gameId, "SELECT id FROM press")).toHaveLength(0);
    // The pledger's own legal order is accepted.
    a.send({ t: "press.send", id: "own", p: { to: bob.power, body: "I hold.", pledge: { orders: [`${mine[0]} H`], sealed: false } } });
    expect((await a.next("press", (m) => m.id === "own")).p.pledge).toMatchObject({ pledger: ann.power, orders: [`${mine[0]} H`] });
    expect(await sql<{ pledger: string }>(ann.gameId, "SELECT pledger FROM pledges")).toEqual([{ pledger: ann.power }]);
  });
});

describe("AI seats hold no credentials", () => {
  it("stores no agent tokens and exposes no agent endpoint to the internet", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const seats = await sql<{ kind: string; token_hash: string | null }>(ann.gameId, "SELECT kind, token_hash FROM seats");
    expect(seats.filter((s) => s.kind === "ai")).toHaveLength(6);
    expect(seats.filter((s) => s.kind === "ai").every((s) => s.token_hash === null)).toBe(true);
    expect(await sql(ann.gameId, "SELECT name FROM sqlite_master WHERE name = 'agent_tokens'")).toHaveLength(0);
    for (const path of ["agent/state", "agent/act", "agentBrief", "agentSubmit", "create", "summary"]) {
      const res = await SELF.fetch(`http://cabal/api/games/${ann.gameId}/${path}`, { method: "POST", headers: { "cf-connecting-ip": nextIp() } });
      expect(res.status).toBe(404);
    }
  });

  it("cannot be claimed with a forged token for an AI seat", async () => {
    const ann = await create("Ann", { aiFill: true });
    await start(ann);
    const ai = (await summary(ann.gameId)).seats.find((s) => s.kind === "ai")!;
    const forged = await Client.connect(ann.gameId, `${ann.gameId}.${ai.power}.${"a".repeat(48)}`);
    expect((await forged.next("error")).p.code).toBe("bad_token");
  });
});

describe("abuse limits", () => {
  it("M4: no frame is free. Oversized and binary frames spend the limiter and close the socket", async () => {
    const ann = await create("Ann");
    const big = await Client.connect(ann.gameId);
    await big.next("welcome");
    big.ws.send("x".repeat(200_000));
    expect((await big.next("error")).p.code).toBe("too_large");
    expect((await big.untilClosed()).code).toBe(1009);

    const binary = await Client.connect(ann.gameId);
    await binary.next("welcome");
    binary.ws.send(new Uint8Array([1, 2, 3]));
    expect((await binary.next("error")).p.code).toBe("too_large");
    expect((await binary.untilClosed()).code).toBe(1009);

    // Multi-byte text is measured in bytes, not characters.
    const wide = await Client.connect(ann.gameId);
    await wide.next("welcome");
    wide.ws.send(JSON.stringify({ t: "press.send", p: { to: "ALL", body: "é".repeat(2500) } }));
    expect((await wide.next("error")).p.code).toBe("too_large");

    // Garbage frames are rate limited like any others.
    const noisy = await Client.connect(ann.gameId);
    await noisy.next("welcome");
    for (let i = 0; i < 80; i++) noisy.ws.send("not json");
    await noisy.next("error", (m) => m.p.code === "rate_limited");
    // The burst allowance was spent on garbage; the rest of the flood was refused unparsed.
    expect(noisy.frames.filter((m) => m.t === "error" && m.p.code === "bad_json").length).toBeLessThan(60);
  });

  it("caps the sockets one seat may hold open", async () => {
    const ann = await create("Ann");
    const sockets = [];
    for (let i = 0; i < 8; i++) {
      const c = await Client.connect(ann.gameId, ann.token);
      await c.next("welcome");
      sockets.push(c);
    }
    const ninth = await Client.connect(ann.gameId, ann.token);
    expect((await ninth.next("error")).p.code).toBe("too_many_sockets");
    expect((await ninth.untilClosed()).code).toBe(4429);
  });

  it("H1: one player's ready frames cannot resolve phases the other players have not readied", async () => {
    const ann = await create("Ann", { aiFill: true, readyAdvance: true });
    const bob = await join(ann.gameId, "Bob");
    await start(ann);
    const a = await Client.connect(ann.gameId, ann.token);
    const units = (await a.next("welcome")).p.state.units[ann.power]!;
    a.send({ t: "orders.set", p: { phase: "S1901M", orders: units.map((u) => `${u} H`) } });
    for (let i = 0; i < 20; i++) {
      a.send({ t: "ready", p: { phase: "S1901M", ready: i % 2 === 0 } });
      a.send({ t: "ready", p: { phase: "F1901M", ready: true } });
    }
    await sleep(300);
    expect((await summary(ann.gameId)).phase).toBe("S1901M");
    expect((await sql<{ n: number }>(ann.gameId, "SELECT COUNT(*) AS n FROM phases"))[0]!.n).toBe(0);
    expect(bob.power).not.toBe(ann.power);
  });

  it("answers CORS preflights and rejects unknown routes and lowercase codes", async () => {
    const options = await SELF.fetch("http://cabal/api/games", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect((await SELF.fetch("http://cabal/api/games/abc234", { headers: { "cf-connecting-ip": nextIp() } })).status).toBe(404);
    expect(POWERS).toHaveLength(7);
  });
});
