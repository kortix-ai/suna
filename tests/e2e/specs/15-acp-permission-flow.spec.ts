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
// the pending request renders the unified `PermissionPrompt`
// (`apps/web/src/features/session/permission-prompt/permission-prompt.tsx`,
// Task WS5-P1-c — collapsed from the old `AcpSessionPermissionPrompt` +
// `SessionApprovalPrompt` "amber twins"), pinned above the composer via
// `SessionChatInput`'s `inputSlot` and still carrying the container testid
// `acp-session-permission-prompt` and the "Allow once" button's testid
// `acp-permission-allow-once` for backward compatibility. Answering it
// resolves the blocked turn in place; UNLIKE the pre-P1-c behavior, the
// resolved request now swaps in place for a compact answered RECORD row
// (`data-testid="permission-record-row"`, auto-clearing itself a couple
// seconds later) before the prompt container itself unmounts — so this spec
// asserts the record row appears, not just that the prompt vanishes.
//
// Test 2 exercises the persistent project permission policy (Task
// WS5-P1-a/b/c): toggling a pending row's "Remember for this project"
// switch calls `rememberToolDecision(tool, 'allow')`, which both
// auto-resolves the currently-open request (through the SAME respond path
// the manual buttons use) and persists the decision project-wide — a
// SECOND shell-command request in the same session for the same tool kind
// is then auto-allowed with no prompt ever requiring a click.

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
      // request from `pendingPermissions`. The row swaps to a compact
      // answered RECORD (Task WS5-P1-c) before the prompt eventually
      // disappears.
      await expect(page.getByTestId('permission-record-row').first()).toBeVisible({ timeout: 1_000 });

      // The unblocked turn runs to completion and the agent's reply lands —
      // the resolution's real, observable effect.
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

  test('enabling "Remember for this project" on a permission auto-allows the same tool kind on a later request', async ({
    page,
  }) => {
    const email = `acp-permflow-remember-${Date.now()}@example.test`;
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
          name: `ACP permission remember flow ${Date.now()}`,
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

      const agentSelector = page.getByTestId('agent-selector');
      await expect(agentSelector).toBeVisible({ timeout: 60_000 });
      await expect(agentSelector).toHaveAttribute('data-harness', 'opencode');

      const composer = page.locator('textarea').last();
      await composer.fill('Use your shell tool to run `pwd`, then reply with exactly: ACP_PONG_1');
      await composer.press('Enter');

      const permissionPrompt = page.getByTestId('acp-session-permission-prompt');
      await expect(permissionPrompt).toBeVisible({ timeout: 120_000 });

      // Toggling "Remember for this project" both persists
      // `toolDecisions[tool] = 'allow'` (`usePermissionPolicy.rememberToolDecision`)
      // AND auto-resolves the currently-open request through the same
      // `onReply` respond path the manual buttons use — no separate click
      // needed.
      const rememberSwitch = permissionPrompt.getByRole('switch', { name: /Remember for this project/i });
      await expect(rememberSwitch).toBeVisible();
      await rememberSwitch.click();

      await expect(page.getByTestId('permission-record-row').first()).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText('ACP_PONG_1').first()).toBeVisible({ timeout: 120_000 });

      // A second shell-command request in the SAME session now auto-allows:
      // the persistent policy layer (project-scoped) answers it before a
      // user ever sees a prompt to click.
      await composer.fill('Use your shell tool to run `pwd` again, then reply with exactly: ACP_PONG_2');
      await composer.press('Enter');

      await expect(page.getByText('ACP_PONG_2').first()).toBeVisible({ timeout: 120_000 });
      // No manual "Allow once" click happened for the second request — if
      // one had been required, the turn would still be blocked and this
      // text would never land within the timeout above.
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
