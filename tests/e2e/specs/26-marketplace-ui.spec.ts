import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createLocalGitRepository } from '../../src/fixtures/local-git';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eMarketplaceUi123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface TemplateCard {
  slug: string;
  title: string;
  repo: string;
  connectors: Array<{ slug: string }>;
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.waitForTimeout(2_000);
  for (let step = 0; step < 12; step += 1) {
    const onboarding = page.getByRole('dialog').last();
    if (!(await onboarding.isVisible().catch(() => false))) break;
    const skip = onboarding.getByRole('button', { name: /^(Skip|Not now|Maybe later)/i }).last();
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
}

test.describe('26 — Marketplace UI', () => {
  /**
   * Two things a screenshot would not catch, so both are asserted as DOM +
   * NETWORK facts here:
   *
   *   1. The grid renders from the API's catalog, not a hardcoded array. So the
   *      assertion is that the card carries the title of a template the public
   *      catalog route returned in THIS run.
   *   2. Install issues a real request. So the assertion is the outgoing POST
   *      body and the authorization outcome — not a toast.
   */
  test('renders the catalog from the API and installs through a real session', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-marketplace-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    // A REAL bare repo, not the fixture's default `ke2e.invalid` placeholder.
    // That placeholder exists so a database-only project fails loudly the moment
    // something touches git — and the install route legitimately does: it reads
    // the project's own kortix.yaml so the agent can merge into it without
    // clobbering what is already there.
    let repository: Awaited<ReturnType<typeof createLocalGitRepository>> | null = null;
    const pageErrors: string[] = [];
    const installPosts: Array<{ url: string; body: string | null }> = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/marketplace/install-session')) {
        installPosts.push({ url: request.url(), body: request.postData() });
      }
    });

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded user owns no account');

      // `marketplace` is flag-gated, and the tab plus the install both fail
      // closed. Seeding the flag with the project keeps the spec on the surface
      // under test instead of the flags UI.
      repository = await createLocalGitRepository(`marketplace-ui-${runId}`);
      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Marketplace UI ${runId}`,
        repoUrl: repository.repoUrl,
        metadata: { experimental: { marketplace: true } },
      });
      projectId = project.id;

      // The catalog is static and public, so the spec reads the same route the
      // store does and asserts the store agrees with it.
      const catalog = await fetch(`${apiBase}/public/marketplace/templates`);
      expect(catalog.status).toBe(200);
      const { templates } = (await catalog.json()) as { templates: TemplateCard[] };
      expect(templates.length).toBeGreaterThan(0);
      const template = templates[0];

      await installBrowserSessionDirect(page, session, `/projects/${project.id}`, authOptions);
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${project.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await dismissOnboarding(page);

      // ── the store renders from the network, not a fixture ────────────────
      const listResponse = page.waitForResponse(
        (response) =>
          response.url().includes('/v1/public/marketplace/templates') &&
          response.request().method() === 'GET' &&
          response.status() === 200,
        { timeout: 60_000 },
      );
      await page.goto(`/projects/${project.id}/customize/marketplace`, {
        waitUntil: 'domcontentloaded',
      });
      const listed = await listResponse;
      const listedBody = (await listed.json()) as { templates: TemplateCard[] };
      expect(listedBody.templates.some((c) => c.slug === template.slug)).toBe(true);

      await expect(page.getByRole('heading', { name: 'Marketplace', exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // The card, addressed by the aria-label the card actually renders.
      const card = page.getByRole('button', { name: `Install ${template.title}` });
      await expect(card).toBeVisible({ timeout: 30_000 });

      // ── the install modal shows the template's real requirements ─────────
      await card.click();
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();
      await expect(modal.getByText(template.title, { exact: false }).first()).toBeVisible();
      // The provenance row links to the repo the card came from.
      await expect(modal.getByText(template.repo, { exact: true }).first()).toBeVisible();
      if (template.connectors.length > 0) {
        await expect(modal.getByText('Connectors it uses', { exact: true })).toBeVisible();
      }

      // ── Install issues a real POST ───────────────────────────────────────
      //
      // The local profile EXCLUDES cloud sandboxes, so session creation answers
      // `503 KORTIX_URL_UNREACHABLE` here — there is no callback origin a
      // sandbox could reach. That is why this step asserts the request and the
      // authorization outcome rather than a live session. The 201 path (a real
      // session, then navigation) is covered against a stack with a reachable
      // callback origin; see MKTP-3 in `tests/src/flows/marketplace.flow.ts`.
      const installResponse = page.waitForResponse(
        (response) =>
          response.url().includes('/marketplace/install-session') &&
          response.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await modal.getByRole('button', { name: 'Install', exact: true }).click();
      const installed = await installResponse;

      // The OUTGOING payload, not just that a request happened.
      expect(installPosts).toHaveLength(1);
      expect(JSON.parse(installPosts[0].body ?? '{}')).toEqual({ slug: template.slug });

      // It got PAST authz, the feature gate, and slug resolution. A 401/403
      // would mean the flag or the capability check is wrong; a 404 would mean
      // the slug the card sent does not resolve; a 400 would mean the body is
      // malformed.
      const installBody = (await installed.json()) as {
        session_id?: string;
        code?: string;
      };
      expect([201, 503]).toContain(installed.status());
      if (installed.status() === 503) {
        expect(installBody.code).toBe('KORTIX_URL_UNREACHABLE');
      } else {
        expect(installBody.session_id).toBeTruthy();
        await page.waitForURL(
          new RegExp(`/projects/${project.id}/sessions/${installBody.session_id}`),
          { timeout: 60_000 },
        );
      }

      expect(pageErrors).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(loadEnv(), projectId);
      await deleteAuthUser(user.id, authOptions);
      await repository?.dispose();
    }
  });
});
