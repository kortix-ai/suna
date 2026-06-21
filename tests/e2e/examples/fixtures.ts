import { test as base, expect } from '@playwright/test';

type AppFixtures = {
  baseURL: string;
};

export const test = base.extend<AppFixtures>({
  baseURL: async ({ baseURL }, use) => {
    await use(baseURL || process.env.E2E_BASE_URL || 'http://localhost:3000');
  },
  page: async ({ page }, use) => {
    await page.context().clearCookies();
    await use(page);
  },
});

export { expect };
