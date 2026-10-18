import { expect, test } from 'bun:test';
import { chromium } from 'playwright';

// Explicit opt-in: this integration check needs the worktree's running web stack.
const origin = process.env.DOWNLOAD_APP_TEST_ORIGIN;
test.skipIf(!origin)('workspace menu opens the download modal without navigation and can reopen after Escape', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/debug/download-app`);
    const url = page.url();
    const open = async () => {
      await page.getByRole('button', { name: 'Switch project', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Download app', exact: true }).click();
      await page.getByRole('heading', { name: 'Download Kortix', exact: true }).waitFor();
      expect(page.url()).toBe(url);
    };
    await open();
    expect(await page.getByRole('heading', { name: 'Terminal', exact: true }).count()).toBe(1);
    expect(await page.locator('code').textContent()).toContain('/install');
    expect(await page.getByRole('link', { name: 'Open App Store', exact: true }).getAttribute('href')).toBe('https://apps.apple.com/app/kortix/id6754448524');
    expect(await page.getByRole('link', { name: 'Open Google Play', exact: true }).getAttribute('href')).toBe('https://play.google.com/store/apps/details?id=com.kortix.application');
    expect(await page.getByRole('img', { name: 'QR code to open', exact: false }).count()).toBe(2);
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Download Kortix', exact: true }).waitFor({ state: 'hidden' });
    await open();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('heading', { name: 'Download Kortix', exact: true }).waitFor({ state: 'hidden' });
    expect(page.url()).toBe(url);
  } finally {
    await browser.close();
  }
}, 30_000);

 test.skipIf(!origin)('download modal preserves the CLI installer without navigating away', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/debug/download-app`);
    await page.getByRole('button', { name: 'Open download modal', exact: true }).click();
    await page.getByRole('heading', { name: 'Terminal', exact: true }).waitFor();
    expect(await page.locator('code').textContent()).toContain('/install');
    expect(page.url()).toContain('/debug/download-app');
  } finally {
    await browser.close();
  }
}, 30_000);
