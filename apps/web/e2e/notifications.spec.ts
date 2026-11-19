import { type Page, expect, test } from "@playwright/test";
import { SECRET, accountRoutes, fakeServer, signedIn } from "./api.js";

/**
 * A browser with push, faked: the suite blocks service workers (so page.route sees every call),
 * and headless Chromium has no push service. The fake records whether the permission prompt was
 * raised, and answers as a person who allowed it.
 */
async function fakePush(page: Page, answer: NotificationPermission = "granted") {
  await page.addInitScript((reply) => {
    const w = window as unknown as Record<string, unknown>;
    w["__asked"] = 0;
    let permission: NotificationPermission = "default";
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static async requestPermission() {
        (w["__asked"] as number)++;
        permission = reply as NotificationPermission;
        return permission;
      }
    }
    let sub: unknown = null;
    const pushManager = {
      getSubscription: async () => sub,
      subscribe: async () => {
        sub = {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-device",
          toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/test-device", expirationTime: null, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }),
          unsubscribe: async () => {
            sub = null;
            return true;
          },
        };
        return sub;
      },
    };
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
    Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({ pushManager }), register: () => new Promise(() => undefined), addEventListener() {}, controller: null },
      configurable: true,
    });
  }, answer);
}

test.describe("notifications", () => {
  test("the browser is asked only when the player presses the button, and the device is registered", async ({ page }) => {
    await fakePush(page);
    const server = await fakeServer(page);
    accountRoutes(server);
    server.on("GET", /^\/api\/push\/key$/, () => ({ body: { publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" } }));
    let registered: unknown = null;
    server.on("POST", /^\/api\/me\/push$/, (request) => {
      registered = { body: request.postDataJSON(), auth: request.headers()["authorization"] };
      return { status: 201, body: { devices: 1 } };
    });
    // The server counts the device once it is registered, as the real one does.
    server.on("GET", /^\/api\/me\/notifications$/, () => ({
      body: { preferences: { deadline: true, phase: true, press: true, started: true, finished: true }, devices: registered ? 1 : 0, reminderMinutes: 30 },
    }));
    await signedIn(page);
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("button", { name: "Notifications" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByText("This device is not told about your games.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
    await card.getByRole("button", { name: "Turn on notifications on this device" }).click();
    await expect(card.getByText("This device is told about your games while you are away from the table.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
    expect(registered).toMatchObject({ auth: `Bearer ${SECRET}`, body: { endpoint: "https://fcm.googleapis.com/fcm/send/test-device" } });
    // The five kinds, each a switch saved on the server.
    let changed: unknown = null;
    server.on("PATCH", /^\/api\/me\/notifications$/, (request) => {
      changed = request.postDataJSON();
      return { body: { preferences: { deadline: true, phase: true, press: false, started: true, finished: true }, devices: 1, reminderMinutes: 30 } };
    });
    await card.getByRole("checkbox", { name: /Private press/ }).uncheck();
    await expect.poll(() => changed).toEqual({ press: false });
  });

  test("a blocked site and a server without push are said plainly", async ({ page }) => {
    await fakePush(page, "denied");
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("button", { name: "Notifications" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    // The default fake server has no push key.
    await card.getByRole("button", { name: "Turn on notifications on this device" }).click();
    await expect(card.getByRole("alert")).toHaveText("Notifications are switched off on this server.");
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
  });

  test("a subscription another account left in the browser is not shown as on", async ({ page }) => {
    // Permission granted and a subscription already in the browser, left by the account that
    // signed out of this device before ada_l signed in.
    await page.addInitScript(() => {
      class FakeNotification {
        static permission: NotificationPermission = "granted";
        static async requestPermission() {
          return "granted" as NotificationPermission;
        }
      }
      const sub = {
        endpoint: "https://fcm.googleapis.com/fcm/send/previous-account",
        options: { applicationServerKey: null },
        toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/previous-account", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }),
        unsubscribe: async () => true,
      };
      const pushManager = { getSubscription: async () => sub, subscribe: async () => sub };
      Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
      Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
      Object.defineProperty(navigator, "serviceWorker", {
        value: { ready: Promise.resolve({ pushManager }), register: () => new Promise(() => undefined), addEventListener() {}, controller: null },
        configurable: true,
      });
      localStorage.setItem("cabal.push.owner", JSON.stringify({ playerId: "pl_someone_else", endpoint: "https://fcm.googleapis.com/fcm/send/previous-account" }));
    });
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/games");
    await page.locator(".player-button").click();
    await page.getByRole("button", { name: "Notifications" }).click();
    const card = page.getByRole("dialog", { name: "Your account" });
    await expect(card.getByText("This device is not told about your games.")).toBeVisible();
    await expect(card.getByText("This device is told about your games while you are away from the table.")).toHaveCount(0);
  });

  test("nothing is offered or asked on arrival", async ({ page }) => {
    await fakePush(page);
    const server = await fakeServer(page);
    accountRoutes(server);
    await signedIn(page);
    await page.goto("/");
    await page.waitForTimeout(500);
    await expect(page.locator(".notify-offer")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
  });
});
