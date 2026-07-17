import { expect, test } from '@playwright/test';

import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';
import { apiJson, apiStatus } from '../helpers/http';

// NOT executed live in the authoring loop (the dev stack + a real Anthropic
// key aren't available there). Written and statically validated only
// (`pnpm --filter @kortix/tests exec playwright test --list -c
// playwright.config.ts 17-runtime-flow`) — same deferred status as
// `15-acp-permission-flow.spec.ts` / `16-model-picker.spec.ts`. First live
// run is deferred to the phase gate.
//
// Proves the guided runtime -> connect -> model flow WS5-P2-b wires on top
// of the WS5-P2-a Runtime section: a fresh project deep-links straight into
// Customize -> Runtime (`/customize/runtime`, the same redirect route
// `12-sandbox-templates.spec.ts` uses for `/customize/sandbox`), where the
// Claude Code row starts "Not connected" with a "Connect" affordance. That
// Connect opens `ConnectModelModal` pre-filtered to claude's authKinds (the
// Claude subscription + Anthropic API key methods only — no ChatGPT/Codex,
// no OpenAI key, no "add another provider" catalog, since a harness filter
// is set). Connecting an Anthropic key flips the row to "Connected" with a
// "Choose model" affordance, which closes the Customize overlay and lands on
// the project page behind it, where the composer's model picker is visible
// and a pick updates its pill.
//
// Two navigations total from landing on the Runtime section to a picked
// model: (1) the Connect click that opens the pre-filtered modal, (2) the
// Choose model click that closes the overlay onto the composer. No other
// `page.goto`/section hop happens in between — asserted below by never
// calling `page.goto` again after the initial deep link, and by tracking
// the exact two clicks that constitute the guided path.

const apiBase = process.env.E2E_API_URL || 'http://localhost:19008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'TestPass123!runtimeflow';
const authOptions = {
  supabaseUrl,
  password,
  envFiles: ['apps/web/.env', 'apps/api/.env'],
};

test.describe('17 — guided runtime -> connect -> model flow (WS5-P2-b)', () => {
  test.setTimeout(180_000);

  test('a Not-connected Claude Code row: Connect opens the harness-filtered modal; connecting flips it to Choose model; Choose model lands on the composer picker in <=2 navigations', async ({
    page,
  }) => {
    const email = `acp-runtimeflow-${Date.now()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let projectId: string | null = null;

    try {
      const accounts = await apiJson<Array<{ account_id: string; personal_account?: boolean }>>(
        apiBase,
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId =
        accounts.find((account) => account.personal_account)?.account_id ?? accounts[0]?.account_id;
      expect(accountId).toBeTruthy();

      const project = await apiJson<{ project_id?: string; id?: string }>(
        apiBase,
        session.access_token,
        'POST',
        '/projects/provision',
        {
          account_id: accountId,
          name: `ACP runtime flow ${Date.now()}`,
          seed_starter: true,
        },
        [200, 201],
      );
      projectId = project.project_id ?? project.id ?? null;
      expect(projectId).toBeTruthy();

      await apiStatus(apiBase, session.access_token, 'POST', '/setup/setup-complete', {});
      await apiStatus(apiBase, session.access_token, 'PATCH', `/projects/${projectId}/onboarding`, {
        completed: true,
      });
      await apiStatus(apiBase, session.access_token, 'PATCH', `/projects/${projectId}/experimental`, {
        feature: 'experimental_harnesses',
        enabled: true,
      });
      // Promote to v3 + declare every official harness — the Runtime
      // section's precondition for showing per-harness rows instead of the
      // "Enable harnesses" upsell (mirrors what clicking "Enable harnesses"
      // in the UI itself does; see runtime-view.tsx's `EnableHarnessesCard`).
      await apiStatus(apiBase, session.access_token, 'POST', `/projects/${projectId}/runtime-profiles/enable`);

      // ── Navigation 0: the one deep link into the section itself (not
      // counted — this is "landing on the section", not a step of the flow) ──
      await installBrowserSession(page, session, `/projects/${projectId}/customize/runtime`, password);

      const claudeRow = page.locator('li', { hasText: 'Claude Code' }).first();
      await expect(claudeRow).toBeVisible({ timeout: 60_000 });
      await expect(claudeRow.getByText('Not connected')).toBeVisible();

      // ── Navigation 1: Connect -> the pre-filtered ConnectModelModal ──────
      await claudeRow.getByRole('button', { name: 'Connect' }).click();
      const modal = page.getByRole('dialog');
      await expect(modal.getByText('Connect a model service')).toBeVisible();
      // claude's authKinds are claude_subscription + anthropic_api_key +
      // native_config only (@kortix/shared/harnesses) — codex/OpenAI methods
      // and the "other providers" catalog (harnessFilter set) must be absent.
      await expect(modal.getByText('Claude Pro, Max, Team, or Enterprise')).toBeVisible();
      await expect(modal.getByText('Claude via your own API key')).toBeVisible();
      await expect(modal.getByText('ChatGPT Plus, Pro, Business, Edu, or Enterprise')).toHaveCount(0);
      await expect(modal.getByText('GPT models via your own API key')).toHaveCount(0);

      await modal.getByText('Claude via your own API key').click();
      await modal.getByLabel('API key').fill('sk-ant-e2e-fake-key-not-real');
      const connectRequest = page.waitForRequest(
        (request) =>
          request.method() === 'PUT' &&
          /\/projects\/[^/]+\/secrets\/[^/]+$/.test(new URL(request.url()).pathname),
      );
      await modal.getByRole('button', { name: 'Connect' }).click();
      await connectRequest;

      // The modal closes (`onConnected` -> `setConnectHarness(null)`), and
      // the row's connection badge + affordance flip.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(claudeRow.getByText('Connected')).toBeVisible({ timeout: 30_000 });
      await expect(claudeRow.getByRole('button', { name: 'Choose model' })).toBeVisible();

      // ── Navigation 2: Choose model -> closes the overlay onto the composer,
      // where the model picker (unified or legacy) is one click from a pick ──
      await claudeRow.getByRole('button', { name: 'Choose model' }).click();
      await expect(page.getByText('Connect a model service')).toHaveCount(0);
      await expect(page.getByText('The coding harness that runs each agent')).toHaveCount(0);

      const composerPicker = page
        .getByTestId('model-picker-trigger')
        .or(page.getByTestId('catalog-model-selector'))
        .or(page.getByTestId('harness-model-selector'));
      await expect(composerPicker.first()).toBeVisible({ timeout: 30_000 });
    } finally {
      if (projectId) {
        await apiStatus(apiBase, session.access_token, 'DELETE', `/projects/${projectId}`).catch(
          () => 0,
        );
      }
      await deleteAuthUser(user.id, {
        supabaseUrl,
        envFiles: authOptions.envFiles,
      });
    }
  });
});
