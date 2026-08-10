import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { Client } from '../../src/core/client';
import { loadEnv } from '../../src/core/env';
import { subscribe } from '../../src/fixtures/billing';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';

const enabled = process.env.E2E_ENABLE_BILLING_JOURNEY === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'BillingJourney123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

interface CheckoutResult {
  checkout_url: string;
}

test.describe
  .serial('10 - Billing customer journey', () => {
    test.skip(!enabled, 'The Stripe-backed billing journey runs only in strict staging QA.');
    test.setTimeout(300_000);

    let user: AuthUser;
    let session: AuthSession;
    let accountId = '';

    test.beforeAll(async () => {
      const email = `billing-browser-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
      user = await createAuthUser(email, authOptions);
      session = await signIn(email, authOptions);
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find((candidate) => candidate.personal_account) ?? accounts[0];
      accountId = account?.account_id ?? '';
      expect(accountId).toBeTruthy();
    });

    test.afterAll(async () => {
      if (session?.access_token) {
        await api(
          session.access_token,
          'DELETE',
          '/billing/account/delete-immediately',
          undefined,
        ).catch(() => {});
      }
      if (accountId) {
        await runDatabaseSql('delete from kortix.accounts where account_id = $1::uuid', [
          accountId,
        ]).catch(() => {});
      }
      if (user?.id) await deleteAuthUser(user.id, authOptions);
    });

    test('an owner starts checkout, reads the active plan, buys credits, and opens billing management', async ({
      page,
    }) => {
      const billingUrl = `/accounts/${accountId}?tab=billing`;
      await installBrowserSessionDirect(page, session, billingUrl, authOptions);
      await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

      await test.step('The owner starts Team checkout from the Billing page', async () => {
        await page.getByRole('button', { name: 'Subscribe to Team' }).click();
        await expect(page.getByRole('heading', { name: 'Subscribe to Kortix' })).toBeVisible();
        const checkoutResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/billing/create-per-seat-checkout',
        );
        await page.getByRole('button', { name: /^Subscribe —/ }).click();
        const checkoutResponse = await checkoutResponsePromise;
        expect(checkoutResponse.status()).toBe(200);
        expect(checkoutResponse.request().postDataJSON()).toMatchObject({
          account_id: accountId,
        });
        const checkout = (await checkoutResponse.json()) as CheckoutResult;
        expect(checkout.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      });

      await test.step('A real Stripe test subscription activates the account', async () => {
        const env = loadEnv();
        const owner = new Client(apiBase).withBearer(session.access_token, 'BROWSER_OWNER');
        await subscribe(env, owner, accountId, 'pro');
      });

      await test.step('The Billing page reads and displays the active subscription', async () => {
        const accountStatePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/v1/billing/account-state' && response.status() === 200;
        });
        await installBrowserSessionDirect(page, session, billingUrl, authOptions);
        const accountState = await accountStatePromise;
        const state = (await accountState.json()) as {
          subscription?: { subscription_id?: string; status?: string };
        };
        expect(state.subscription?.subscription_id).toBeTruthy();
        expect(state.subscription?.status).toBe('active');
        await expect(page.getByText('Active', { exact: true })).toBeVisible();
      });

      await test.step('The owner starts a one-time credit purchase', async () => {
        await page.getByRole('button', { name: '$10', exact: true }).click();
        const purchaseResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/billing/purchase-credits',
        );
        await page.getByRole('button', { name: 'Buy $10 in credits' }).click();
        const purchaseResponse = await purchaseResponsePromise;
        expect(purchaseResponse.status()).toBe(200);
        expect(purchaseResponse.request().postDataJSON()).toMatchObject({
          account_id: accountId,
          amount: 10,
        });
        const purchase = (await purchaseResponse.json()) as CheckoutResult;
        expect(purchase.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      });

      await test.step('The owner opens Stripe Billing Portal for lifecycle actions', async () => {
        await installBrowserSessionDirect(page, session, billingUrl, authOptions);
        const portalResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/billing/create-portal-session',
        );
        await page.getByRole('button', { name: 'Manage billing' }).last().click();
        const portalResponse = await portalResponsePromise;
        expect(portalResponse.status()).toBe(200);
        expect(portalResponse.request().postDataJSON()).toMatchObject({
          account_id: accountId,
        });
        const portal = (await portalResponse.json()) as {
          portal_url?: string;
          url?: string;
        };
        expect(portal.portal_url ?? portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
      });
    });
  });
