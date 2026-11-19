import { type Page, expect, test } from "@playwright/test";
import { isPhone, openSheet, ready } from "./helpers.js";

const field = (page: Page) => page.getByRole("combobox", { name: "Write an order" });
const note = (page: Page) => page.locator(".order-entry-note");
const orders = (page: Page, power: string) => page.getByLabel(`${power} orders`);

test.describe("orders written as text", () => {
  test("a typed order is read like a player writes it, and an illegal one is refused with the reason", async ({
    page,
  }) => {
    await ready(page);
    await openSheet(page);
    await field(page).fill("a par -> bur");
    await field(page).press("Enter");
    await expect(note(page)).toHaveText("Written: A PAR - BUR.");
    await expect(orders(page, "France").locator(".row.given code")).toHaveText(["A PAR - BUR"]);
    await expect(field(page)).toHaveValue("");

    await field(page).fill("A MAR - MUN");
    await field(page).press("Enter");
    await expect(note(page)).toHaveClass(/alert/);
    await expect(note(page)).toContainText("A MAR - MUN:");
    await expect(note(page)).toContainText("not adjacent");
    // Kept, so it can be corrected.
    await expect(field(page)).toHaveValue("A MAR - MUN");
    await expect(orders(page, "France").locator(".row.given code")).toHaveText(["A PAR - BUR"]);
  });

  test("legal orders are suggested as you type and chosen with the keyboard", async ({ page }) => {
    await ready(page);
    await openSheet(page);
    await field(page).fill("par pi");
    const list = page.getByRole("listbox", { name: "Legal orders" });
    await expect(list.getByRole("option").first()).toContainText("A PAR - PIC");
    await expect(list.getByRole("option")).toContainText(["A PAR - PIC", "F BRE S A PAR - PIC"]);
    await field(page).press("ArrowDown");
    await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", /opt-0$/);
    await field(page).press("Enter");
    await expect(orders(page, "France").locator(".row.given code")).toHaveText(["A PAR - PIC"]);
    await expect(list).toBeHidden();
  });

  test("orders for other powers and several at once go where they belong", async ({ page }) => {
    await ready(page);
    await openSheet(page);
    await field(page).fill("f lon - eng; A MUN supports A BER -> KIE; a ber-kie");
    await field(page).press("Enter");
    await expect(note(page)).toHaveText("Written: F LON - ENG; A MUN S A BER - KIE; A BER - KIE.");
    // The last order's power is opened, as a click on its unit would.
    await expect(orders(page, "Germany").locator(".row.given code")).toHaveText(["A BER - KIE", "A MUN S A BER - KIE"]);
    await page.locator("table.powers").getByRole("button", { name: "England" }).click();
    await expect(orders(page, "England").locator(".row.given code")).toHaveText(["F LON - ENG"]);
  });

  test("slash opens the field from the board", async ({ page }, info) => {
    test.skip(isPhone(info), "A keyboard shortcut; the phone has the field in its sheet.");
    await ready(page);
    await page.locator("body").press("/");
    await expect(field(page)).toBeFocused();
  });
});
