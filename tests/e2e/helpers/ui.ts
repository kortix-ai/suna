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

/**
 * Dismiss the "Welcome from Marko" card if it is on screen.
 *
 * It is a FIXED card in the bottom-right corner (`aside[role=complementary]`)
 * that renders when its content loads — which can be after a page's first
 * paint. Any control it covers becomes unclickable: the v0.13.18 release gate
 * failed on `Save` in spec 29 with "subtree intercepts pointer events", after
 * an earlier one-shot check had found no card. Call this immediately before
 * clicking a control near that corner, not once per page load.
 */
export async function dismissWelcomeCard(page: Page): Promise<void> {
  const welcome = page
    .getByRole("complementary", { name: /Welcome from Marko/i })
    .last();
  if (!(await welcome.isVisible().catch(() => false))) return;
  const dismiss = welcome
    .getByRole("button", { name: /dismiss|close/i })
    .last();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click({ force: true, timeout: 2_000 }).catch(() => {});
  }
  await welcome.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

export async function dismissOnboarding(page: Page): Promise<void> {
  const onboarding = page
    .getByRole("dialog")
    .filter({
      has: page.getByRole("progressbar", { name: "Setup progress" }),
    })
    .last();
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
