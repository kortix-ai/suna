import { type Page, expect } from '@playwright/test';

export async function selectAccountForUi(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    localStorage.setItem(
      'kortix.currentAccount',
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}

export async function dismissOnboarding(page: Page): Promise<void> {
  await page.waitForTimeout(2_000);
  for (let step = 0; step < 12; step += 1) {
    const onboarding = page.getByRole('dialog').last();
    if (!(await onboarding.isVisible().catch(() => false))) break;
    const skip = onboarding
      .getByRole('button', { name: /^(Skip|Skip survey|Not now|Maybe later)/i })
      .last();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      const primary = onboarding
        .getByRole('button', {
          name: /^(Continue|Done|Open project|Start building|Get started)$/i,
        })
        .last();
      if (!(await primary.isVisible().catch(() => false))) break;
      await primary.click();
    }
    await page.waitForTimeout(250);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
