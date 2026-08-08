import { type Page, expect } from "@playwright/test";

export async function selectAccountForUi(
  page: Page,
  accountId: string,
): Promise<void> {
  await page.evaluate((id) => {
    localStorage.setItem(
      "kortix.currentAccount",
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}

export async function dismissOnboarding(page: Page): Promise<void> {
  const onboarding = page.locator(
    '[role="dialog"][aria-labelledby^="onboarding-"]',
  );
  let absentSince = 0;
  for (let step = 0; step < 24; step += 1) {
    if (!(await onboarding.isVisible().catch(() => false))) {
      if (absentSince === 0) absentSince = Date.now();
      if (Date.now() - absentSince >= 1_000) return;
      await page.waitForTimeout(100);
      continue;
    }
    absentSince = 0;
    const skip = onboarding
      .getByRole("button", { name: /^(Skip|Skip survey|Not now|Maybe later)/i })
      .last();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click({ timeout: 2_000 }).catch(() => {});
    } else {
      const defer = onboarding.getByRole("radio", {
        name: /^(Decide later|Keep what I have)/i,
      });
      if (await defer.isVisible().catch(() => false)) {
        await defer.click({ timeout: 2_000 }).catch(() => {});
      }
      const primary = onboarding
        .getByRole("button", {
          name: /^(Continue|Done|Open project|Start building|Get started)$/i,
        })
        .last();
      if (await primary.isEnabled().catch(() => false)) {
        await primary.click({ timeout: 2_000 }).catch(() => {});
      }
    }
    await page.waitForTimeout(100);
  }
  await expect(onboarding).toHaveCount(0);
}
