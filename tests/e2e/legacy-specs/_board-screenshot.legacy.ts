import { test, expect } from '@playwright/test';

test('board surfaces visible after login', async ({ page }) => {
  test.setTimeout(180_000);
  // Login via Supabase API (fast path)
  const tokenRes = await fetch('http://127.0.0.1:54321/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY ?? require('fs').readFileSync('/Users/vukasinkubet/dev/comp/apps/web/.env','utf8').match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)$/m)[1].trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'vukasinkubet@gmail.com', password: '123456' }),
  });
  // Form login is more reliable than cookie injection
  await page.goto('http://localhost:3000/auth/password');
  const lock = page.getByText('Click or press Enter to sign in');
  if (await lock.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true }).catch(() => {});
  }
  await page.locator('input[name="email"]').fill('vukasinkubet@gmail.com');
  await page.locator('input[name="password"]').fill('123456');
  await page.locator('form').getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/auth'), { timeout: 90_000 });

  await page.goto('http://localhost:3000/workspace');
  const lock2 = page.getByText('Click or press Enter to sign in');
  if (await lock2.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true }).catch(() => {});
  }

  // Wait for the right sidebar to render. It usually has a 'Files' button by default.
  await page.waitForTimeout(3_000);

  // Look for any Board element anywhere
  const boardCount = await page.getByRole('button', { name: /^Board$/ }).or(page.getByRole('link', { name: /^Board$/ })).count();
  console.log('Board buttons/links visible:', boardCount);

  // Take a full screenshot
  await page.screenshot({ path: '/tmp/board-state.png', fullPage: false });
  console.log('Screenshot saved to /tmp/board-state.png');

  // Check what the right sidebar actually contains
  const sidebarText = await page.locator('aside, [data-sidebar="sidebar"]').allTextContents();
  console.log('Sidebar contents (first 5):', sidebarText.slice(0, 5).map(s => s.slice(0, 100)));
});
