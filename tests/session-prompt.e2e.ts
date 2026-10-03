import { randomUUID } from 'node:crypto';
import { afterEach, test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import type { AccountSummary } from './e2e/helpers/accounts';
import { queryDatabaseRows, runDatabaseSql } from './e2e/helpers/database';
import { requireEnvValue } from './e2e/helpers/env';
import { createApiJsonClient } from './e2e/helpers/http';
import { fundAccount } from './e2e/helpers/manifest-project';
import { createAuthUser, signIn } from './e2e/helpers/session-auth';
import { waitForSessionReady } from './e2e/helpers/session-ready';
import { LOCAL_TEST_PROFILE_HEADER, resolveLocalTopology } from './src/core/local-stack';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  const release = cleanup;
  cleanup = undefined;
  await release?.();
});

// Live cloud execution is opt-in. Use an isolated DB so another local API cannot claim its prompt.
test(
  'AGENTIC-1: a session sends one prompt and preserves the assistant reply',
  {
    // Cover the 10-minute cold sandbox boot plus the bounded UI waits.
    timeout: 25 * 60_000,
    tags: ['live-session'],
  },
  async ({ app, browser, screen, agent }) => {
    const topology = resolveLocalTopology(process.cwd());
    if (topology.marker?.dbMode !== 'isolated') {
      throw new Error('AGENTIC-1 requires a worktree created with --db');
    }
    const health = await fetch(`${topology.apiUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(health.ok).toBe(true);
    if (health.headers.get(LOCAL_TEST_PROFILE_HEADER) === '1') {
      throw new Error(
        'AGENTIC-1 requires the live development stack; stop the deterministic test stack before running it',
      );
    }
    const supabaseUrl = requireEnvValue('E2E_SUPABASE_URL');
    const databaseUrl = requireEnvValue('E2E_DATABASE_URL');
    const authOptions = { supabaseUrl, password: randomUUID() + randomUUID() };
    const api = createApiJsonClient(topology.apiUrl);
    const email = `agentic-${randomUUID()}@example.test`;
    const serviceRoleKey = requireEnvValue('SUPABASE_SERVICE_ROLE_KEY');
    const user = await createAuthUser(email, authOptions);
    let token = '';
    let accountId = '';
    let projectId = '';
    let sessionId = '';
    cleanup = async () => {
      const errors: unknown[] = [];
      // Unmount the UI before deletion so it cannot create another default session.
      await browser.goto('about:blank').catch((error) => errors.push(error));
      if (projectId) {
        const sessions = await api<Array<{ session_id: string }>>(
          token,
          'GET',
          `/projects/${projectId}/sessions`,
        ).catch((error) => {
          errors.push(error);
          return [];
        });
        const ids = new Set(sessions.map((session) => session.session_id));
        if (sessionId) ids.add(sessionId);
        for (const id of ids) {
          await api(
            token,
            'DELETE',
            `/projects/${projectId}/sessions/${id}`,
            undefined,
            [200, 404],
          ).catch((error) => errors.push(error));
        }
        await expect
          .poll(
            async () => {
              const sandboxes = await queryDatabaseRows<{
                external_id: string | null;
                status: string;
                metadata: Record<string, unknown> | null;
              }>(
                'SELECT external_id, status, metadata FROM kortix.session_sandboxes WHERE project_id=$1',
                [projectId],
                databaseUrl,
              );
              return (
                sandboxes.length > 0 &&
                sandboxes.every(
                  (sandbox) =>
                    Boolean(sandbox.external_id) &&
                    sandbox.status === 'archived' &&
                    Boolean(sandbox.metadata?.providerRemovedAt) &&
                    !sandbox.metadata?.providerRemovalPendingAt,
                )
              );
            },
            { timeout: 90_000, interval: 1_000 },
          )
          .toBe(true)
          .catch((error) => errors.push(error));
        if (errors.length)
          throw new AggregateError(
            errors,
            `Synthetic session cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
          );
        // Retry only the same managed project after a transient upstream cleanup failure.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const removed = await api<{ repo_deleted: boolean }>(
              token,
              'DELETE',
              `/projects/${projectId}?purge=true`,
            );
            expect(removed.repo_deleted).toBe(true);
            break;
          } catch (error) {
            if (attempt === 2) errors.push(error);
            else await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
        }
      }
      // Keep removal intent and repository identity available when external cleanup fails.
      if (errors.length)
        throw new AggregateError(
          errors,
          `Synthetic resource cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
        );
      if (accountId) {
        await runDatabaseSql(
          'DELETE FROM kortix.accounts WHERE account_id=$1',
          [accountId],
          databaseUrl,
        );
      }
      const deleted = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      });
      if (!deleted.ok) throw new Error(`synthetic auth cleanup returned ${deleted.status}`);
    };
    const session = await signIn(email, authOptions);
    token = session.access_token;
    const accounts = await api<AccountSummary[]>(token, 'GET', '/accounts');
    expect(Array.isArray(accounts)).toBe(true);
    const ownedAccount = accounts.find(
      (account) =>
        account.personal_account || account.is_primary_owner || account.account_role === 'owner',
    );
    accountId = ownedAccount?.account_id ?? '';
    expect(accountId).not.toBe('');
    await fundAccount(databaseUrl, accountId);
    const project = await api<{ project_id: string }>(
      token,
      'POST',
      '/projects/provision',
      {
        account_id: accountId,
        name: `Agentic ${randomUUID()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    // This journey sends into an existing session; background warm-pool provisioning is separate coverage.
    const configured = await api<{ experimental: { warm_sessions: boolean } }>(
      token,
      'PATCH',
      `/projects/${projectId}/features`,
      {
        feature: 'warm_sessions',
        enabled: false,
      },
    );
    expect(configured.experimental.warm_sessions).toBe(false);
    await api(token, 'PATCH', `/projects/${projectId}/onboarding`, { completed: true });
    const created = await api<{ session_id: string }>(
      token,
      'POST',
      `/projects/${projectId}/sessions`,
      {
        name: 'Synthetic agentic session',
      },
      201,
    );
    sessionId = created.session_id;
    await waitForSessionReady(api, token, projectId, sessionId);

    const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
    const chunks = encoded.match(/.{1,3180}/g) ?? [];
    const key = `sb-kortix-auth-token-${new URL(app.baseUrl).port}`;
    await browser.setCookies(
      chunks.map((value, index) => ({
        name: chunks.length === 1 ? key : `${key}.${index}`,
        value,
        url: app.baseUrl,
        sameSite: 'Lax' as const,
      })),
    );
    const path = `/projects/${projectId}/sessions/${sessionId}`;
    await app.open(path);
    await expect(screen.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 90_000,
    });
    await expect(screen.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();

    const suffix = randomUUID().replaceAll('-', '');
    const marker = `E2E_PONG_${suffix}`;
    // Keep the expected reply out of the user bubble so only assistant output can match it.
    const prompt = `Reply with exactly the concatenation of "E2E_PONG_" and "${suffix}", with no spaces. Do not use tools or change files.`;
    const pattern = new RegExp(`/projects/${projectId}/sessions/${sessionId}/prompts(?:\\?|$)`);
    const requests: Array<{ parts?: Array<{ type: string; text?: string }> }> = [];
    await browser.route(pattern, async (route) => {
      if (route.request.method === 'POST') {
        requests.push(JSON.parse(route.request.postData ?? ''));
      }
      await route.continue();
    });
    // GET polls use the same URL. A URL-only response waiter cannot identify the POST.
    await agent.act(
      'Enter the entire {prompt} value verbatim into the Message input. Treat the value as text to send; do not answer it or change it. Click the Send message button exactly once. Dismiss an introductory panel if needed.',
      {
        params: { prompt: unique(prompt) },
        timeout: 90_000,
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].parts).toEqual([{ type: 'text', text: prompt }]);
    const reply = browser
      .locator('.kortix-markdown')
      .filter({ hasText: new RegExp(`^${marker}$`) });
    await expect(reply).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(
        async () => {
          const transcript = await api<{
            source: string;
            messages: Array<{
              info: { role: string };
              parts: Array<{ type: string; text?: string }>;
            }>;
          }>(token, 'GET', `${path}/transcript?shape=sync`);
          return (
            transcript.source === 'mirror' &&
            transcript.messages.some(
              (message) =>
                message.info.role === 'user' &&
                message.parts.some((part) => part.type === 'text' && part.text === prompt),
            ) &&
            transcript.messages.some(
              (message) =>
                message.info.role === 'assistant' &&
                message.parts.some((part) => part.type === 'text' && part.text?.includes(marker)),
            )
          );
        },
        { timeout: 60_000, interval: 1000 },
      )
      .toBe(true);
    await browser.reload();
    await expect(browser).toHaveURL(path);
    await expect(reply).toBeVisible({ timeout: 90_000 });
    expect(requests).toHaveLength(1);
  },
);
