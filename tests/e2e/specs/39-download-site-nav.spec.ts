import { expect, test } from "@playwright/test";

test.describe("39 — The public /download page keeps the site navigation", () => {
  // Regression for KRTX-1792. `/download` used to sit outside the marketing
  // route group, so a signed-out visitor who opened a pasted link got a page
  // with no navbar, no brand link home, and no menu — the only exits were the
  // browser's back button. The page must carry the same site chrome as every
  // other public marketing page.
  test("a signed-out visitor gets the brand link home and the nav menu", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto("/download", { waitUntil: "domcontentloaded" });
    expect(response?.ok()).toBe(true);

    // The navbar logo links home.
    const home = page.getByRole("link", { name: "Kortix home" });
    await expect(home.first()).toBeVisible();

    // At phone width the desktop links collapse into the drawer, and the
    // drawer opens from the page. A tap that lands before the client bundle has
    // hydrated has no listener, so retry until the drawer answers — once it is
    // open, no further tap is sent (the button would close it again).
    const closeMenu = page.getByRole("button", { name: "Close menu" });
    await expect(async () => {
      if (!(await closeMenu.isVisible())) {
        await page.getByRole("button", { name: "Open menu" }).click();
      }
      await expect(closeMenu).toBeVisible();
    }).toPass({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  });
});
