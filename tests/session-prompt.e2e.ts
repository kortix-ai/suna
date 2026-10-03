import { randomUUID } from 'node:crypto';
import { afterEach, test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { runDatabaseSql } from './e2e/helpers/database';
import { requireEnvValue } from './e2e/helpers/env';
import { createApiJsonClient } from './e2e/helpers/http';
import { createAuthUser, signIn } from './e2e/helpers/session-auth';
import { waitForSessionReady } from './e2e/helpers/session-ready';
import { resolveLocalTopology } from './src/core/local-stack';

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
    const supabaseUrl = requireEnvValue('E2E_SUPABASE_URL');
    const databaseUrl = requireEnvValue('E2E_DATABASE_URL');
    const authOptions = { supabaseUrl, password: randomUUID() + randomUUID() };
    const api = createApiJsonClient(topology.apiUrl);
    const email = `agentic-${randomUUID()}@example.test`;
    const serviceRoleKey = requireEnvValue('SUPABASE_SERVICE_ROLE_KEY');
    const user = await createAuthUser(email, authOptions);
    let token = '';
    let projectId = '';
    let sessionId = '';
    cleanup = async () => {
      const errors: unknown[] = [];
      // Purge only the managed repository created above. Attempt every cleanup even if one fails.
      if (projectId && sessionId) {
        await api(token, 'DELETE', `/projects/${projectId}/sessions/${sessionId}`).catch((error) =>
          errors.push(error),
        );
      }
      if (projectId) {
        await api(token, 'DELETE', `/projects/${projectId}?purge=true`).catch((error) =>
          errors.push(error),
        );
      }
      await runDatabaseSql(
        'DELETE FROM kortix.accounts WHERE account_id=$1',
        [user.id],
        databaseUrl,
      ).catch((error) => errors.push(error));
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      })
        .then((deleted) => {
          if (!deleted.ok)
            errors.push(new Error(`synthetic auth cleanup returned ${deleted.status}`));
        })
        .catch((error) => errors.push(error));
      if (errors.length) throw new AggregateError(errors, 'Synthetic session cleanup failed');
    };
    const session = await signIn(email, authOptions);
    token = session.access_token;
    const accounts = await api<Array<{ account_id: string; personal_account: boolean }>>(
      token,
      'GET',
      '/accounts',
    );
    expect(accounts.find((account) => account.personal_account)?.account_id).toBe(user.id);
    await runDatabaseSql(
      `
      INSERT INTO kortix.credit_accounts
        (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
      VALUES ($1, 1000, 1000, 1000, 1000, 'tier_2_20')
      ON CONFLICT (account_id) DO UPDATE SET balance=1000, balance_precise=1000,
        non_expiring_credits=1000, non_expiring_credits_precise=1000, tier='tier_2_20'
    `,
      [user.id],
      databaseUrl,
    );
    const project = await api<{ project_id: string }>(
      token,
      'POST',
      '/projects/provision',
      {
        account_id: user.id,
        name: `Agentic ${randomUUID()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
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

    const marker = `E2E_PONG_${randomUUID().replaceAll('-', '')}`;
    const prompt = `Reply with exactly ${marker}. Do not use tools or change files.`;
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
      'Send {prompt} once using the Message input and Send message button. Dismiss an introductory panel if needed.',
      {
        params: { prompt: unique(prompt) },
        timeout: 90_000,
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].parts).toEqual([{ type: 'text', text: prompt }]);
    await expect(screen.getByText(marker, { exact: true })).toBeVisible({ timeout: 180_000 });
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
    await expect(screen.getByText(marker, { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(requests).toHaveLength(1);
  },
);
