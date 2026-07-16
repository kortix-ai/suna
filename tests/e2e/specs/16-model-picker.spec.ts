import { expect, test } from '@playwright/test';

import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from '../helpers/session-auth';
import { apiJson, apiStatus } from '../helpers/http';

// NOT executed live in the authoring loop (the dev stack + a real harness
// sandbox aren't available there). This spec is written and statically
// validated only (`pnpm --filter @kortix/tests exec playwright test --list
// -c playwright.config.ts 16-model-picker`) — first live run is deferred to
// the phase gate, same status as `15-acp-permission-flow.spec.ts`.
//
// Flags a fresh project with BOTH `unified_model_picker` (the flag this task
// wires) AND `experimental_harnesses` (a project must already have this on
// before claude/codex/pi are SELECTABLE at all — see
// `14-acp-harness-selector.spec.ts` and `apps/api/src/experimental/features.ts`)
// via `PATCH /projects/{id}/experimental`, then opens the session and proves:
// (1) exactly one `model-picker-trigger` renders and neither legacy testid
// (`catalog-model-selector`, `harness-model-selector`) does, for the default
// opencode agent; (2) switching to Claude (experimental harness) shows the
// same picker with an `Experimental` badge and a `Not connected` group (a
// fresh account has no claude/codex/pi connection yet); (3) picking a model
// updates the trigger's pill label.

const apiBase = process.env.E2E_API_URL || 'http://localhost:19008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'TestPass123!modelpicker';
const authOptions = {
  supabaseUrl,
  password,
  envFiles: ['apps/web/.env', 'apps/api/.env'],
};

test.describe('16 — unified ModelPicker behind the unified_model_picker flag', () => {
  test.setTimeout(180_000);

  test('flag ON renders one ModelPicker for opencode and claude alike, with Experimental + Not connected, and a pick updates the pill', async ({
    page,
  }) => {
    const email = `acp-modelpicker-${Date.now()}@example.test`;
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
          name: `ACP model picker ${Date.now()}`,
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
        feature: 'unified_model_picker',
        enabled: true,
      });
      await apiStatus(apiBase, session.access_token, 'PATCH', `/projects/${projectId}/experimental`, {
        feature: 'experimental_harnesses',
        enabled: true,
      });

      await installBrowserSession(page, session, `/projects/${projectId}`, password);

      // ── (1) opencode: exactly one ModelPicker, no legacy pickers ──────────
      const modelPicker = page.getByTestId('model-picker-trigger');
      await expect(modelPicker).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('model-picker-trigger')).toHaveCount(1);
      await expect(page.getByTestId('catalog-model-selector')).toHaveCount(0);
      await expect(page.getByTestId('harness-model-selector')).toHaveCount(0);

      // ── (2) switch to Claude — same picker, Experimental + Not connected ──
      const agentSelector = page.getByTestId('agent-selector');
      await agentSelector.click();
      await page.locator('[data-testid="agent-option"][data-harness="claude"]').click();
      await expect(agentSelector).toHaveAttribute('data-harness', 'claude');

      await expect(page.getByTestId('model-picker-trigger')).toHaveCount(1);
      await expect(page.getByTestId('catalog-model-selector')).toHaveCount(0);
      await expect(page.getByTestId('harness-model-selector')).toHaveCount(0);

      await modelPicker.click();
      await expect(page.getByText('Experimental').first()).toBeVisible();
      await expect(page.getByText('Not connected')).toBeVisible();

      // ── (3) picking a model updates the pill ───────────────────────────────
      const priorLabel = (await modelPicker.textContent())?.trim();
      const firstSelectableRow = page
        .locator('[cmdk-item]:not([aria-disabled="true"])')
        .first();
      await firstSelectableRow.click();
      await expect(modelPicker).not.toHaveText(priorLabel ?? '');
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
