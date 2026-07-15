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
// -c playwright.config.ts 15-acp-permission-flow`) — first live run is
// deferred to the phase gate. Follows `14-acp-harness-selector.spec.ts`'s
// bootstrap helpers and prompts the default `opencode`/`kortix` agent with a
// shell command — the same harness+prompt combination
// `tests/e2e/scripts/acp-session-smoke.ts` already proves reliably triggers a
// `session/request_permission` with no special session config (Kortix has no
// caller-settable "ask"/permission-mode field on session creation).
//
// Permissions now surface in the COMPOSER, not as an inline transcript card:
// the pending request renders `AcpSessionPermissionPrompt`
// (`data-testid="acp-session-permission-prompt"`, pinned above the composer
// via `SessionChatInput`'s `inputSlot`), whose "Allow once" button carries
// `data-testid="acp-permission-allow-once"`. Answering it resolves the
// blocked turn in place; the prompt then unmounts (the request leaves
// `pendingPermissions`) and leaves NO record row in the transcript — so
// "resolved" is proven by the prompt disappearing AND the agent's turn
// completing (its `ACP_PONG` reply landing), before and after a reload.

const apiBase = process.env.E2E_API_URL || 'http://localhost:19008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const password = 'TestPass123!permflow';
const authOptions = {
  supabaseUrl,
  password,
  envFiles: ['apps/web/.env', 'apps/api/.env'],
};

test.describe('15 — ACP permission request/response flow', () => {
  test.setTimeout(180_000);

  test('composer permission prompt appears, Allow once answers it without reload, and the resolution survives a reload', async ({
    page,
  }) => {
    const email = `acp-permflow-${Date.now()}@example.test`;
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
          name: `ACP permission flow ${Date.now()}`,
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
      await installBrowserSession(page, session, `/projects/${projectId}`, password);

      // Default agent (`opencode`/`kortix`) — no `agent_name` override, same
      // as spec 14's baseline state before it switches harnesses.
      const agentSelector = page.getByTestId('agent-selector');
      await expect(agentSelector).toBeVisible({ timeout: 60_000 });
      await expect(agentSelector).toHaveAttribute('data-harness', 'opencode');

      // A shell command the default agent must ask permission for — mirrors
      // `tests/e2e/scripts/acp-session-smoke.ts`'s proven permission-triggering
      // prompt.
      const composer = page.locator('textarea').last();
      await composer.fill('Use your shell tool to run `pwd`, then reply with exactly: ACP_PONG');
      await composer.press('Enter');

      // The pending request pins the amber permission prompt above the
      // composer (NOT an inline transcript card).
      const permissionPrompt = page.getByTestId('acp-session-permission-prompt');
      await expect(permissionPrompt).toBeVisible({ timeout: 120_000 });

      const allowOnce = page.getByTestId('acp-permission-allow-once').first();
      await expect(allowOnce).toBeVisible();
      await allowOnce.click();

      // Resolves in place WITHOUT a reload — the optimistic local echo
      // (`AcpSession.respondPermission` -> `respondWithEcho`) drops the
      // request from `pendingPermissions`, so the prompt unmounts within 1s.
      await expect(permissionPrompt).toHaveCount(0, { timeout: 1_000 });

      // The unblocked turn runs to completion and the agent's reply lands —
      // the resolution's real, observable effect (there is no answered
      // record row for a resolved permission any more).
      await expect(page.getByText('ACP_PONG').first()).toBeVisible({ timeout: 120_000 });

      // Reload: the request was already answered and is part of the persisted
      // transcript, so no pending prompt resurrects and the completed turn
      // (its `ACP_PONG` reply) is still there.
      await page.reload();
      await expect(page.getByTestId('acp-session-chat')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('ACP_PONG').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-session-permission-prompt')).toHaveCount(0);
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
