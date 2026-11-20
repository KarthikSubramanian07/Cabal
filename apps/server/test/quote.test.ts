/**
 * Quoting in press: a dispatch may quote an earlier message of its own thread by id, and the room
 * attaches the original's words itself, so a quote can never put words in anybody's mouth.
 */
import { describe, expect, it } from "vitest";
import { Client, create, join, start } from "./helpers.js";

/** A started game with three people seated and connected (the rest played by the bot). */
async function three() {
  const ann = await create("Ann", { aiFill: true, pacing: "live" });
  const bob = await join(ann.gameId, "Bob");
  const cat = await join(ann.gameId, "Cat");
  await start(ann);
  const a = await Client.connect(ann.gameId, ann.token);
  const b = await Client.connect(ann.gameId, bob.token);
  const c = await Client.connect(ann.gameId, cat.token);
  await Promise.all([a.next("welcome"), b.next("welcome"), c.next("welcome")]);
  return { ann, bob, cat, a, b, c };
}

describe("quoting a message", () => {
  it("attaches the quoted message's own words, for both ends of a private thread", async () => {
    const { ann, bob, a, b } = await three();
    a.send({ t: "press.send", id: "m1", p: { to: bob.power, body: "I will not enter the Channel this year." } });
    const original = (await a.next("press", (m) => m.id === "m1")).p;
    await b.next("press", (m) => m.p.id === original.id);

    b.send({ t: "press.send", id: "m2", p: { to: ann.power, body: "Your words, not mine.", quote: original.id } });
    const echo = (await b.next("press", (m) => m.id === "m2")).p;
    expect(echo.quote).toEqual({ id: original.id, from: ann.power, phase: original.phase, excerpt: "I will not enter the Channel this year." });
    const received = (await a.next("press", (m) => m.p.id === echo.id)).p;
    expect(received.quote).toEqual(echo.quote);
    // A message that quotes nothing says so.
    expect(original.quote ?? null).toBeNull();
  });

  it("keeps the quote in the history a reconnecting player is welcomed with", async () => {
    const { ann, bob, a, b } = await three();
    a.send({ t: "press.send", id: "t1", p: { to: "ALL", body: "Peace in the Balkans." } });
    const original = (await a.next("press", (m) => m.id === "t1")).p;
    b.send({ t: "press.send", id: "t2", p: { to: "ALL", body: "Noted.", quote: original.id } });
    await b.next("press", (m) => m.id === "t2");
    const again = await Client.connect(ann.gameId, bob.token);
    const welcome = await again.next("welcome");
    const reply = welcome.p.press.find((m) => m.body === "Noted.");
    expect(reply?.quote).toMatchObject({ id: original.id, from: ann.power, excerpt: "Peace in the Balkans." });
  });

  it("refuses a quote from another thread, one the sender cannot read, or one that does not exist", async () => {
    const { ann, bob, cat, a, b, c } = await three();
    a.send({ t: "press.send", id: "w1", p: { to: bob.power, body: "Between us: I move on Munich." } });
    const secret = (await a.next("press", (m) => m.id === "w1")).p;
    await b.next("press", (m) => m.p.id === secret.id);

    // Bob cannot carry Ann's private words to the whole table, or to Cat.
    b.send({ t: "press.send", id: "x1", p: { to: "ALL", body: "Look what Ann said.", quote: secret.id } });
    expect((await b.next("error", (m) => m.id === "x1")).p.code).toBe("bad_quote");
    b.send({ t: "press.send", id: "x2", p: { to: cat.power, body: "Look what Ann said.", quote: secret.id } });
    expect((await b.next("error", (m) => m.id === "x2")).p.code).toBe("bad_quote");
    // Cat never read it at all.
    c.send({ t: "press.send", id: "x3", p: { to: ann.power, body: "I know.", quote: secret.id } });
    expect((await c.next("error", (m) => m.id === "x3")).p.code).toBe("bad_quote");
    c.send({ t: "press.send", id: "x4", p: { to: "ALL", body: "Hm.", quote: "nosuchid" } });
    expect((await c.next("error", (m) => m.id === "x4")).p.code).toBe("bad_quote");
    // Nothing refused was sent.
    expect(a.frames.filter((m) => m.t === "press" && m.p.body.startsWith("Look what"))).toEqual([]);
  });

  it("cuts a long original to its first 280 characters", async () => {
    const { ann, bob, a, b } = await three();
    const long = `${"The Black Sea stays empty. ".repeat(15)}End.`;
    a.send({ t: "press.send", id: "l1", p: { to: bob.power, body: long } });
    const original = (await a.next("press", (m) => m.id === "l1")).p;
    b.send({ t: "press.send", id: "l2", p: { to: ann.power, body: "Quoting you.", quote: original.id } });
    const reply = (await b.next("press", (m) => m.id === "l2")).p;
    expect(reply.quote!.excerpt.length).toBeLessThanOrEqual(280);
    expect(reply.quote!.excerpt.endsWith("…")).toBe(true);
    expect(long.startsWith(reply.quote!.excerpt.slice(0, -1).trimEnd())).toBe(true);
  });
});
