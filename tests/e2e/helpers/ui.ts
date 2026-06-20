import type { Page } from '@playwright/test';

export async function selectAccountForUi(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    localStorage.setItem(
      'kortix.currentAccount',
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}
