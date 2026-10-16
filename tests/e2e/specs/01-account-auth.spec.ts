import { type Page, type Request, expect, test } from '@playwright/test';

import { pollDatabaseRows, queryDatabaseRows, runDatabaseSql } from '../helpers/database';
import { type AuthEmailAction, createDisposableInbox, emailProviderStatus } from '../helpers/inbox';
import { clearCookiesPreservingBypass } from '../helpers/deployment-bypass';
import { deleteAuthUser } from '../helpers/session-auth';

const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const authOptions = {
  supabaseUrl,
  envFiles: ['apps/api/.env', 'apps/web/.env'],
};

interface UserRow {
  id: string;
}

interface AccountRow {
  account_id: string;
}

async function requestEmailAuthentication(page: Page, email: string) {
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Welcome to Kortix' })).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as typeof window & { __ENV_LOGGED__?: boolean }).__ENV_LOGGED__),
  );
  await page.getByLabel('Email').fill(email);
  const sentAt = new Date();
  const continueButton = page.getByRole('button', {
    name: 'Continue',
    exact: true,
  });
  await expect(continueButton).toBeEnabled();
  let submitted = false;
  for (let attempt = 1; attempt <= 3 && !submitted; attempt += 1) {
    const formRequest = page
      .waitForRequest(
        // The email-link default posts to the send-code route (#9773); the
        // password-only path posts the auth server action.
        (request) =>
          request.method() === 'POST' &&
          ['/auth', '/api/auth/send-code'].includes(new URL(request.url()).pathname),
        { timeout: 2_000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.getByLabel('Email').press('Enter');
    submitted = await formRequest;
    if (!submitted) {
      await expect(continueButton).toBeEnabled();
    }
  }
  expect(submitted, 'the hydrated auth form submits the email').toBe(true);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  return sentAt;
}

async function completeEmailAuthentication(page: Page, action: AuthEmailAction) {
  if (action.kind === 'link') {
    await page.goto(action.value, { waitUntil: 'domcontentloaded' });
  } else {
    await page.getByLabel('Digit 1').fill(action.value);
  }
  await expect(page).not.toHaveURL(/\/auth(?:[/?]|$)/, { timeout: 60_000 });
}

test.describe('01 - Account authentication', () => {
  test.setTimeout(180_000);

  test.beforeEach(async () => {
    const { available, reason } = await emailProviderStatus();
    test.skip(!available, `email provider unavailable: ${reason}`);
  });

  test('a new user creates an account from the delivered email, clears the session, and logs in again', async ({
    page,
  }) => {
    const inbox = await createDisposableInbox();
    const email = inbox.email;
    let userId: string | null = null;
    const accountIds: string[] = [];

    try {
      await test.step('A new email receives a real signup message', async () => {
        const sentAt = await requestEmailAuthentication(page, email);
        const action = await inbox.waitForAuthAction(sentAt);
        await completeEmailAuthentication(page, action);
        // The account ids this test must clean up come from the database, not
        // from a `page.waitForResponse('/v1/accounts')`.
        //
        // That wait was the single most frequent failure of the deployed gate:
        // `TimeoutError: page.waitForResponse: Timeout 30000ms exceeded` on
        // runs 32240074477 and 32231251280. It is not a product assertion —
        // nothing was asserted about the response beyond harvesting ids the
        // `finally` block already re-reads from `kortix.account_members`. And
        // it is unsound as a wait: whether the freshly authenticated app
        // issues exactly one `GET /v1/accounts` that resolves 200 inside 30s
        // is a client cache and hydration detail, and on a staging replica
        // answering 503 it never resolves at all.
        //
        // What the step actually proves is unchanged and stronger:
        // `completeEmailAuthentication` already asserts the browser left
        // `/auth`, and the row below proves the user exists.
        const rows = await pollDatabaseRows<UserRow>(
          'select id::text from auth.users where lower(email) = lower($1) limit 1',
          [email],
        );
        userId = rows[0]?.id ?? null;
        expect(userId, `no auth.users row for ${email}`).toBeTruthy();
        const accountRows = await queryDatabaseRows<AccountRow>(
          'select distinct account_id::text from kortix.account_members where user_id = $1::uuid',
          [userId],
        ).catch(() => []);
        for (const row of accountRows) accountIds.push(row.account_id);
      });

      await test.step('The test clears the browser session', async () => {
        // Clears the APP session. The deployment-protection cookie is
        // infrastructure, not session state — dropping it would 302 every later
        // navigation to vercel.com/sso-api instead of logging the user out.
        await clearCookiesPreservingBypass(page.context());
        await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => {
          window.localStorage.clear();
          window.sessionStorage.clear();
        });
        await clearCookiesPreservingBypass(page.context());
      });

      await test.step('The existing user receives a second email and logs in again', async () => {
        const sentAt = await requestEmailAuthentication(page, email);
        const action = await inbox.waitForAuthAction(sentAt);
        await completeEmailAuthentication(page, action);
      });
    } finally {
      if (!userId) {
        const rows = await queryDatabaseRows<UserRow>(
          'select id::text from auth.users where lower(email) = lower($1) limit 1',
          [email],
        ).catch(() => []);
        userId = rows[0]?.id ?? null;
      }
      if (userId) {
        const rows = await queryDatabaseRows<AccountRow>(
          'select distinct account_id::text from kortix.account_members where user_id = $1::uuid',
          [userId],
        ).catch(() => []);
        for (const row of rows) {
          if (!accountIds.includes(row.account_id)) accountIds.push(row.account_id);
        }
      }
      for (const accountId of accountIds) {
        await runDatabaseSql('delete from kortix.accounts where account_id = $1::uuid', [
          accountId,
        ]);
      }
      if (userId) {
        await deleteAuthUser(userId, authOptions);
      }
      await inbox.dispose();
    }
  });

  // The dogfood run's signature: open /auth on a cold browser, type the
  // address, press Enter once — and no request fires, while a click after the
  // wait submits. The entry form's SSR HTML is typeable before React hydrates
  // it, and in that window an Enter either performs a native GET navigation
  // to /auth?email=… (discarding the typed address) or React 19's hydration
  // resets the field to its server-rendered value so the later Enter submits
  // nothing. Holding every JS chunk makes the window deterministic; whatever
  // the network does, the one Enter must reach the app's submit path (a
  // POST) carrying the address that was typed.
  const deleteEntryUser = async (email: string) => {
    const rows = await queryDatabaseRows<UserRow>(
      'select id::text from auth.users where lower(email) = lower($1) limit 1',
      [email],
    ).catch(() => []);
    const userId = rows[0]?.id ?? null;
    if (userId) await deleteAuthUser(userId, authOptions);
  };

  // Armed BEFORE the Enter: the post-hydration variant's POST fires the
  // instant the key lands, and a listener registered afterwards never sees it.
  const watchEntrySubmit = (page: Page) =>
    page.waitForRequest(
      (candidate) =>
        candidate.method() === 'POST' &&
        ['/auth', '/api/auth/send-code'].includes(new URL(candidate.url()).pathname),
      { timeout: 25_000 },
    );

  const expectEntryGapSubmit = async (page: Page, email: string, request: Request) => {
    expect(
      request.postData(),
      'the submit that finally fired carries the address typed before hydration',
    ).toContain(email.split('@')[0]);
    // No native GET navigation: the URL must not carry the address, and the
    // flow must land on the link step, not a reloaded entry form.
    expect(page.url(), 'no native form GET may leak into the URL').not.toContain('email=');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  };

  const holdChunks = (page: Page, ms: number) => {
    // Hold every JS chunk for `ms` after the SSR HTML: the form is typeable
    // but unhydrated — the window a cold visit on a deployed env spends
    // waiting for chunks.
    return page.route('**/*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    });
  };

  test('an Enter pressed inside the hydration gap submits the typed address', async ({ page }) => {
    const email = `e2e-enter-gap-${Date.now()}@kortix.test`;
    await holdChunks(page, 3000);
    const submitted = watchEntrySubmit(page);
    try {
      await page.goto('/auth', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(email);
      await page.keyboard.press('Enter');
      await expectEntryGapSubmit(page, email, await submitted);
    } finally {
      await deleteEntryUser(email);
    }
  });

  test('typing that survives the gap submits on the post-hydration Enter', async ({ page }) => {
    const email = `e2e-enter-late-${Date.now()}@kortix.test`;
    await holdChunks(page, 3000);
    // The app dispatches kortix:auth-hydrated when its mount effect runs —
    // record that so the Enter below provably lands after hydration.
    await page.addInitScript(() => {
      window.addEventListener('kortix:auth-hydrated', () => {
        (window as unknown as Record<string, unknown>).__kortixAuthHydrated = true;
      });
    });
    const submitted = watchEntrySubmit(page);
    try {
      await page.goto('/auth', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email').fill(email);
      // Wait for the app to be live so the Enter lands after hydration — the
      // variant where React wiped the field under the visitor's eyes. If the
      // signal never comes the Enter still fires; the assertions hold for
      // whichever side of the gap it lands on.
      await page
        .waitForFunction('window.__kortixAuthHydrated === true', { timeout: 15_000 })
        .catch(() => {});
      await page.keyboard.press('Enter');
      await expectEntryGapSubmit(page, email, await submitted);
    } finally {
      await deleteEntryUser(email);
    }
  });
});
