import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { closeSheet, isPhone, openSheet, primary, ready } from "./helpers.js";

const field = (page: Page) => page.getByRole("combobox", { name: "Write an order" });
const results = (page: Page) => page.getByRole("group", { name: "Adjudication results" });
const live = (page: Page) => page.locator("svg.board-live");

/** Write orders as text, for any powers (each is routed to its power). */
async function write(page: Page, orders: string) {
  await openSheet(page);
  await field(page).fill(orders);
  await field(page).press("Enter");
  await closeSheet(page);
}

/** Every animation on the board's piece layer, finished. */
const settle = (page: Page) =>
  page.evaluate(() => Promise.all(document.querySelector("svg.board-live")!.getAnimations({ subtree: true }).map((a) => a.finished)));

/** The centre of a piece, and the box of a province, in page pixels. */
async function pieceIn(page: Page, label: string, province: string) {
  return page.evaluate(
    ({ label, province }) => {
      const piece = [...document.querySelectorAll("svg.board-live g.unit")].find((g) => g.querySelector("title")?.textContent === label);
      const prov = document.querySelector(`svg.board [data-province="${province}"]`);
      if (!piece || !prov) return null;
      const p = piece.querySelector(".body")!.getBoundingClientRect();
      const b = prov.getBoundingClientRect();
      const x = p.left + p.width / 2;
      const y = p.top + p.height / 2;
      return x > b.left && x < b.right && y > b.top && y < b.bottom;
    },
    { label, province },
  );
}

test.describe("a phase played on the board", () => {
  test("pieces march along their arrows and rest where the phase leaves them", async ({ page }) => {
    await ready(page);
    await write(page, "A PAR - BUR; A MAR S A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    // The pieces travel: transform keyframes that change, on the piece layer.
    const travels = await page.evaluate(() =>
      document
        .querySelector("svg.board-live")!
        .getAnimations({ subtree: true })
        .some((a) => new Set(((a.effect as KeyframeEffect).getKeyframes() ?? []).map((k) => String(k.transform ?? ""))).size > 2),
    );
    expect(travels).toBe(true);
    await settle(page);
    // Paris marched into Burgundy; Munich bounced and is back home.
    expect(await pieceIn(page, "France: A PAR", "BUR")).toBe(true);
    expect(await pieceIn(page, "Germany: A MUN", "MUN")).toBe(true);
    // Results are drawn under the pieces, so the army stands on its own arrowhead.
    const order = await live(page).evaluate((svg) => [...svg.children].map((c) => c.getAttribute("class")));
    expect(order.indexOf("order-marks results")).toBeLessThan(order.indexOf("units"));
  });

  test("Skip lands every piece and every stamp at once", async ({ page }) => {
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    // The phase lasts about a second; find Skip and press it within a frame or two of adjudicating.
    const pressed = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          document.querySelector<HTMLButtonElement>(".sidebar .actions .btn.primary")!.click();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const skip = [...document.querySelectorAll<HTMLButtonElement>(".board-tools button")].find((b) => b.textContent?.startsWith("Skip"));
              skip?.click();
              resolve(Boolean(skip));
            }),
          );
        }),
    );
    expect(pressed).toBe(true);
    await expect(page.getByRole("button", { name: "Skip the animation" })).toBeHidden();
    const running = await page.evaluate(
      () => document.querySelector("svg.board-live")!.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
    );
    expect(running).toBe(0);
    for (const opacity of await live(page).locator(".fail-mark .stamp").evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))) {
      expect(opacity).toBe("1");
    }
    expect(await pieceIn(page, "France: A PAR", "PAR")).toBe(true);
  });

  test("a dislodged unit is knocked aside and then drawn as dislodged", async ({ page }) => {
    await ready(page);
    await write(page, "A MUN - BUR; A MAR - GAS");
    await primary(page).click();
    await settle(page);
    await primary(page).click();
    await write(page, "A PAR - BUR; A GAS S A PAR - BUR; A BUR H");
    await primary(page).click();
    await settle(page);
    await expect(live(page).locator("g.unit.dislodged")).toHaveCount(1);
    expect(await pieceIn(page, "France: A PAR", "BUR")).toBe(true);
  });
});

/** Every animation on the page brought to its end (the ones with no end left alone). */
const finishAll = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => {
          a.finish();
          return a.finished.catch(() => undefined);
        }),
    ),
  );

const skipButton = (page: Page) => page.getByRole("button", { name: "Skip the animation" });

test.describe("ink and the keyboard while a phase plays", () => {
  test("no ink shows on the map before an order starts to draw", async ({ page }, info) => {
    test.skip(isPhone(info), "the mask is the same at any size");
    await ready(page);
    await write(page, "A PAR - BUR; A MAR S A PAR - BUR; A MUN - BUR; F TRI - VEN; A VEN - TRI");
    await primary(page).click();
    // Hold the phase at its very start and look at the order marks alone. (Paused first: a time
    // set on a running animation has moved on a frame by the time a pause takes hold.)
    await page.evaluate(() => document.getAnimations().forEach((a) => (a.pause(), (a.currentTime = 0))));
    // Every ink mask starts with its dashes clear of both ends of its path (a path length of 1):
    // the dash before it ends short of the start, the next one begins past the end. A dash of no
    // length at an end is still painted, as a dot, by the round cap.
    const masks = await page.evaluate(() =>
      [...document.querySelectorAll(".order-marks .reveal")].map((el) => {
        const cs = getComputedStyle(el);
        const [dash, gap] = cs.strokeDasharray.split(/[ ,]+/).map(parseFloat);
        return { dash: dash!, gap: gap!, offset: parseFloat(cs.strokeDashoffset) };
      }),
    );
    expect(masks.length).toBeGreaterThan(0);
    for (const m of masks) {
      expect(m.dash - m.offset).toBeLessThan(0);
      expect(m.dash + m.gap - m.offset).toBeGreaterThan(1);
    }
    await page.addStyleTag({ content: "svg.board, .board-live .units, .board-tools, .zoom, .pan { visibility: hidden !important }" });
    const withMarks = await live(page).screenshot();
    await page.addStyleTag({ content: ".board-live .order-marks { display: none !important }" });
    const without = await live(page).screenshot();
    // Nothing has been drawn yet, so the marks add not one pixel (a round cap on a zero-length
    // dash at either end of a mark used to paint a dot there).
    expect(withMarks.equals(without)).toBe(true);
  });

  test("pressing Skip keeps focus on the board's tools", async ({ page }, info) => {
    test.skip(isPhone(info), "keyboard");
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    await skipButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(skipButton(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Sound" })).toBeFocused();
  });

  test("a focused Skip that goes at the end of the phase hands focus on", async ({ page }, info) => {
    test.skip(isPhone(info), "keyboard");
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    await skipButton(page).focus();
    await expect(skipButton(page)).toBeHidden({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Sound" })).toBeFocused();
  });

  test("Escape skips the phase from wherever focus is", async ({ page }, info) => {
    test.skip(isPhone(info), "keyboard");
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    await expect(skipButton(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(skipButton(page)).toBeHidden();
    const running = await page.evaluate(
      () => document.querySelector("svg.board-live")!.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
    );
    expect(running).toBe(0);
    expect(await pieceIn(page, "France: A PAR", "PAR")).toBe(true);
  });

  test("a speed changed part way through a phase keeps Skip until every piece has landed", async ({ page }, info) => {
    test.skip(isPhone(info), "one viewport is enough");
    await ready(page);
    for (let i = 0; i < 2; i++) {
      await write(page, "A PAR - BUR; A MUN - BUR; A VEN - TRI; F TRI - VEN; F LON - NTH; F KIE - DEN");
      await primary(page).click();
      await finishAll(page);
      await expect(skipButton(page)).toBeHidden();
      await primary(page).click();
    }
    await page.getByRole("button", { name: "Double speed" }).click();
    await page.getByRole("button", { name: "Replay the game from the start" }).click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: "Half speed" }).click();
    // For two seconds: Skip is never gone while a piece is still moving.
    for (let i = 0; i < 20; i++) {
      const s = await page.evaluate(() => ({
        skip: [...document.querySelectorAll(".board-tools button")].some((b) => b.textContent?.startsWith("Skip")),
        running: document.querySelector("svg.board-live")!.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
      }));
      if (s.running > 0) expect(s.skip, `${s.running} animations still running at sample ${i}`).toBe(true);
      await page.waitForTimeout(100);
    }
  });
});

test.describe("order arrows", () => {
  test("each kind of order has its own shape", async ({ page }) => {
    await ready(page);
    await write(page, "A PAR - BUR; A MAR S A PAR - BUR; F BRE - MAO; F LON H; A VEN S A ROM");
    const marks = live(page).locator(".order-marks");
    await expect(marks.locator("g.order.move")).toHaveCount(2);
    // A barbed head: tip, wing, notch, wing.
    const head = await marks.locator("g.order.move polygon.head").first().getAttribute("points");
    expect(head!.trim().split(/\s+/)).toHaveLength(4);
    // Supports end in a round knot at the move they back (or the unit they hold up).
    await expect(marks.locator("g.order.support circle.knot")).toHaveCount(2);
    await expect(marks.locator("g.order.hold circle.stroke")).toHaveCount(1);
  });
});

test.describe("why did this fail", () => {
  test("a bounced move names the unit it met, both strengths, and picks them out on the map", async ({ page }) => {
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    await openSheet(page);
    const why = results(page).getByRole("button", { name: "Why? A PAR - BUR" });
    await expect(why).toHaveAttribute("aria-expanded", "false");
    await why.click();
    await expect(why).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: "Why A PAR - BUR failed" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Bounced");
    await expect(panel).toContainText("A MUN");
    await expect(panel.locator(".why-ledger tr")).toHaveCount(2);
    await expect(panel.locator(".tally-n")).toHaveText(["1", "1"]);
    await expect(live(page)).toHaveClass(/highlighting/);
    await expect(live(page).locator(".hl.focus")).toHaveCount(1);
    await expect(live(page).locator(".hl.against")).toHaveCount(1);
    await expect(live(page).locator("g.order.dim")).toHaveCount(0);

    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

    await why.click();
    await expect(panel).toBeHidden();
    await expect(live(page)).not.toHaveClass(/highlighting/);
  });

  test("a cut support says who cut it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);
    await write(page, "A VEN - PIE");
    await primary(page).click();
    await primary(page).click();
    await write(page, "A PAR - BUR; A MAR S A PAR - BUR; A MUN - BUR; A PIE - MAR");
    await primary(page).click();
    await openSheet(page);
    await results(page).getByRole("button", { name: "Why? A MAR S A PAR - BUR" }).click();
    const panel = page.getByRole("region", { name: "Why A MAR S A PAR - BUR failed" });
    await expect(panel).toContainText("Support cut");
    await expect(panel.locator(".why-note")).toContainText("A PIE");
    await expect(live(page).locator(".hl.against")).toHaveCount(1);
  });

  test("a convoy paradox shows the rule and its circle", async ({ page }) => {
    await ready(page);
    await openSheet(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: "pandins-paradox.json",
      mimeType: "application/json",
      buffer: await readFile(new URL("./fixtures/pandins-paradox.json", import.meta.url)),
    });
    await closeSheet(page);
    await write(page, "F LON S F WAL - ENG; F WAL - ENG; A BRE - LON VIA; F ENG C A BRE - LON; F NTH S F BEL - ENG; F BEL - ENG");
    await primary(page).click();
    await openSheet(page);
    await results(page).getByRole("button", { name: "Why? F ENG C A BRE - LON" }).click();
    const panel = page.getByRole("region", { name: /Why F ENG C A BRE - LON/ });
    await expect(panel).toContainText("Szykman");
    await expect(panel.locator(".why-cycle li").first()).toBeVisible();
  });
});

test.describe("what if", () => {
  test("predicts a phase from sketched orders and changes nothing", async ({ page }) => {
    const requests: string[] = [];
    await ready(page);
    page.on("request", (r) => requests.push(r.url()));
    page.on("websocket", (w) => requests.push(w.url()));
    await page.locator(".toolbar").getByRole("button", { name: "What if" }).click();
    await expect(page.locator(".sketch-stamp")).toBeVisible();
    await expect(live(page)).toHaveClass(/sketch/);
    await write(page, "A PAR - BUR; A MUN - BUR; F LON - NTH");
    await openSheet(page);
    const predicted = page.getByRole("group", { name: "Predicted results" });
    await expect(predicted.locator(".receipt.fail")).toHaveCount(2);
    await expect(predicted).toContainText("Standoff in Burgundy");
    // Where the sketch would leave a unit: a dashed piece in the North Sea.
    await closeSheet(page);
    await expect(live(page).locator("g.ghost-unit")).toHaveCount(1);
    // Why, for a predicted failure too.
    await openSheet(page);
    await predicted.getByRole("button", { name: "Why? A PAR - BUR" }).click();
    await expect(page.getByRole("region", { name: "Why A PAR - BUR failed" })).toContainText("A MUN");
    await expect(page.locator(".sheet-note")).toHaveText("What if: 3 orders sketched");

    // Play it out, then discard: the game is where it was and nothing was sent.
    await page.getByRole("button", { name: "Play it out" }).click();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.locator(".sketch-stamp")).toHaveCount(0);
    await expect(page.locator(".phase-header code")).toHaveText("S1901M");
    await expect(page.getByRole("button", { name: "Undo last phase" })).toBeDisabled();
    await expect(page.getByLabel("France orders").locator(".row.given")).toHaveCount(0);
    expect(requests.filter((u) => !u.startsWith("data:"))).toEqual([]);
  });

  test("a sketch can become the real orders", async ({ page }) => {
    await ready(page);
    await write(page, "A MAR - GAS");
    await page.locator(".toolbar").getByRole("button", { name: "What if" }).click();
    await write(page, "A PAR - PIC");
    await openSheet(page);
    await page.getByRole("button", { name: "Use these orders" }).click();
    await expect(page.locator(".sketch-stamp")).toHaveCount(0);
    await expect(page.getByLabel("France orders").locator(".row.given code")).toHaveText(["A PAR - PIC", "A MAR - GAS"]);
  });
});

test.describe("sound", () => {
  test("is off by default, makes no audio until switched on, and the choice is kept", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { made: number; AudioContext: typeof AudioContext };
      w.made = 0;
      const Real = w.AudioContext;
      w.AudioContext = class extends Real {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          w.made++;
        }
      };
    });
    await ready(page);
    const toggle = page.getByRole("button", { name: "Sound" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    expect(await page.evaluate(() => (window as unknown as { made: number }).made)).toBe(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => (window as unknown as { made: number }).made)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("cabal.sound"))).toBe("on");
    await page.reload();
    await expect(page.getByRole("button", { name: "Sound" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the replay timeline", () => {
  test("marks the phases where something happened and reads them out", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);
    await write(page, "A PAR - BUR; A MUN - BUR");
    await primary(page).click();
    await openSheet(page);
    await expect(page.locator(".timeline-phase .glyph.standoffs")).toHaveCount(1);
    await expect(page.getByRole("slider", { name: "Scrub through the game" })).toHaveAttribute(
      "aria-valuetext",
      "Spring 1901 movement results: 1 standoff",
    );
  });
});
