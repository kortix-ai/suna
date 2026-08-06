import { expect, test, type Page } from "@playwright/test";

type Theme = "light" | "dark";

async function loadDesignSystem(
  page: Page,
  theme: Theme,
  hash: string,
): Promise<void> {
  await page.addInitScript(
    (value) => localStorage.setItem("theme", value),
    theme,
  );
  await page.goto(`/design-system#${hash}`, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
}

test.describe("Smooth shadow system", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} aliases expose depth and a one-pixel smooth ring`, async ({
      page,
    }) => {
      await loadDesignSystem(page, theme, "shadows");

      for (const size of ["sm", "md", "lg"] as const) {
        const boxShadow = await page
          .getByTestId(`shadow-demo-${size}`)
          .evaluate((element) => getComputedStyle(element).boxShadow);
        expect(boxShadow).not.toBe("none");
        expect(boxShadow).toContain("0px 0px 0px 1px");
      }
    });

    test(`${theme} shared overlays keep one visible edge`, async ({ page }) => {
      await loadDesignSystem(page, theme, "components");

      await page.getByTestId("shadow-trigger-menu").click();
      const menu = page.getByTestId("shadow-demo-menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS("border-top-width", "0px");
      await expect(menu).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-dialog").click();
      const dialog = page.getByTestId("shadow-demo-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("border-top-width", "0px");
      await expect(dialog).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-popover").click();
      const popover = page.getByTestId("shadow-demo-popover");
      await expect(popover).toBeVisible();
      await expect(popover).toHaveCSS("border-top-width", "0px");
      await expect(popover).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-modal").click();
      const modal = page.getByTestId("shadow-demo-modal");
      await expect(modal).toBeVisible();
      await expect(modal).toHaveCSS("border-top-width", "0px");
      const modalShadow = await modal.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      expect(modalShadow).toContain("0px 0px 0px 1px");
      await page.keyboard.press("Escape");

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("shadow-trigger-modal").click();
      await expect(modal).toBeVisible();
      await expect(modal).toHaveCSS("border-top-width", "1px");
      const narrowModalShadow = await modal.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      expect(narrowModalShadow).not.toBe("none");
      expect(narrowModalShadow).not.toContain("0px 0px 0px 1px");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-sheet").click();
      const sheet = page.getByTestId("shadow-demo-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).not.toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Escape");

      await page.getByTestId("shadow-trigger-toast").click();
      const toast = page.locator('[data-slot="toast-surface"]');
      await expect(toast).toBeVisible();
      await expect(toast).toHaveCSS("border-top-width", "0px");
      await expect(toast).not.toHaveCSS("box-shadow", "none");
    });

    for (const viewport of [
      { name: "desktop", width: 1280, height: 720 },
      { name: "narrow", width: 390, height: 844 },
    ] as const) {
      test(`${theme} ${viewport.name} shadow reference`, async ({ page }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await loadDesignSystem(page, theme, "shadows");
        await expect(page.locator("#shadows")).toHaveScreenshot(
          `shadows-${theme}-${viewport.name}.png`,
        );
      });
    }
  }
});
