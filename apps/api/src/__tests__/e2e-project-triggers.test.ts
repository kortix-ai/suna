import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountGithubInstallations,
  accountMembers,
  projectMembers,
  projectSecrets,
  projectSessions,
  projectTriggerEvents,
  projectTriggers,
  projects,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const TRIGGER_ID = '00000000-0000-4000-a000-000000000401';
const EVENT_ID = '00000000-0000-4000-a000-000000000501';

let triggerRows: Array<typeof projectTriggers.$inferSelect>;
let eventRows: Array<typeof projectTriggerEvents.$inferSelect>;
let sessionRows: Array<typeof projectSessions.$inferSelect>;
let branchCreateCalls = 0;
let sandboxProvisionCalls = 0;
let provisioningSessionCount = 0;
let activeSessionCount = 0;
let lastProvisionEnv: Record<string, string> | null = null;

const projectRow: typeof projects.$inferSelect = {
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  name: 'Trigger Project',
  repoUrl: 'https://github.com/kortix-ai/trigger-project.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  status: 'active',
  metadata: {},
  lastOpenedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function triggerRow(overrides: Partial<typeof projectTriggers.$inferSelect> = {}): typeof projectTriggers.$inferSelect {
  return {
    triggerId: TRIGGER_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    type: 'webhook',
    config: { secret: 'hook-secret' },
    agentName: 'default',
    promptTemplate: 'Handle {{ body.action }}: {{ body.issue.title }}',
    enabled: true,
    createdBy: USER_ID,
    metadata: {},
    lastFiredAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function resetState() {
  triggerRows = [];
  eventRows = [];
  sessionRows = [];
  branchCreateCalls = 0;
  sandboxProvisionCalls = 0;
  provisioningSessionCount = 0;
  activeSessionCount = 0;
  lastProvisionEnv = null;
}

function sign(rawBody: string, secret = 'hook-secret') {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'triggers@example.test');
    await next();
  },
}));

mock.module('../projects/git', () => ({
  createRemoteSessionBranch: async () => {
    branchCreateCalls += 1;
  },
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
}));

mock.module('../projects/github', () => ({
  buildGitHubAppInstallUrl: () => 'https://github.com/apps/kortix-test/installations/new',
  commitFile: async () => undefined,
  createInstallationToken: async () => ({ token: 'installation-token' }),
  createRepo: async () => {
    throw new Error('not used');
  },
  getFileSha: async () => null,
  getGitHubAppInstallation: async () => ({
    account: { login: 'kortix-org', type: 'Organization' },
    repository_selection: 'all',
    permissions: {},
  }),
  isGithubAppConfigured: () => false,
  isGithubPatConfigured: () => true,
}));

mock.module('../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (input: any) => {
    sandboxProvisionCalls += 1;
    lastProvisionEnv = input.extraEnvVars;
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => ACCOUNT_ID,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'triggers@example.test' } } }),
      },
    },
  }),
}));

mock.module('../billing/repositories/credit-accounts', () => ({
  getSubscriptionInfo: async () => ({ tier: 'free' }),
}));

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const result: any[] & { orderBy?: () => Promise<any[]>; limit?: () => Promise<any[]> } = [];
          result.orderBy = async () => {
            if (table === projectTriggers) return triggerRows;
            if (table === projectSecrets) return [];
            if (table === projectSessions) return sessionRows;
            return [];
          };
          result.limit = async () => {
            if (fields && Object.keys(fields).includes('activeCount')) {
              return [{ activeCount: activeSessionCount }];
            }
            if (fields && Object.keys(fields).includes('provisioningCount')) {
              return [{ provisioningCount: provisioningSessionCount }];
            }
            if (table === projects) return [projectRow];
            if (table === accountMembers) return [{ accountId: ACCOUNT_ID, accountRole: 'owner' }];
            if (table === accountGithubInstallations) return [];
            if (table === projectMembers) return [];
            if (table === projectTriggers) return triggerRows.slice(0, 1);
            if (table === projectSessions) return sessionRows.slice(0, 1);
            return [];
          };
          return result;
        },
        orderBy: async () => {
          if (table === projectTriggers) return triggerRows;
          if (table === projectSessions) return sessionRows;
          return [];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        onConflictDoUpdate: () => ({
          returning: async () => [],
        }),
        returning: async () => {
          const now = new Date('2026-01-02T00:00:00Z');
          if (table === projectTriggers) {
            const row: typeof projectTriggers.$inferSelect = {
              triggerId: values.triggerId ?? TRIGGER_ID,
              accountId: values.accountId,
              projectId: values.projectId,
              type: values.type,
              config: values.config ?? {},
              agentName: values.agentName ?? 'default',
              promptTemplate: values.promptTemplate,
              enabled: values.enabled ?? true,
              createdBy: values.createdBy ?? null,
              metadata: values.metadata ?? {},
              lastFiredAt: values.lastFiredAt ?? null,
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            triggerRows.push(row);
            return [row];
          }
          if (table === projectTriggerEvents) {
            const row: typeof projectTriggerEvents.$inferSelect = {
              eventId: values.eventId ?? `${EVENT_ID.slice(0, -1)}${eventRows.length + 1}`,
              triggerId: values.triggerId,
              accountId: values.accountId,
              projectId: values.projectId,
              status: values.status ?? 'queued',
              payload: values.payload ?? {},
              renderedPrompt: values.renderedPrompt ?? null,
              sessionId: values.sessionId ?? null,
              error: values.error ?? null,
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            eventRows.push(row);
            return [row];
          }
          if (table === projectSessions) {
            const row: typeof projectSessions.$inferSelect = {
              sessionId: values.sessionId,
              accountId: values.accountId,
              projectId: values.projectId,
              branchName: values.branchName,
              baseRef: values.baseRef,
              sandboxProvider: values.sandboxProvider,
              sandboxId: values.sandboxId ?? null,
              sandboxUrl: null,
              opencodeSessionId: null,
              agentName: values.agentName ?? 'default',
              status: values.status ?? 'provisioning',
              error: null,
              metadata: values.metadata ?? {},
              createdAt: values.createdAt ?? now,
              updatedAt: values.updatedAt ?? now,
            };
            sessionRows.push(row);
            return [row];
          }
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: any) => ({
        where: () => ({
          returning: async () => {
            if (table === projectTriggers) {
              triggerRows[0] = { ...triggerRows[0]!, ...updates };
              return [triggerRows[0]];
            }
            if (table === projectTriggerEvents) {
              eventRows[0] = { ...eventRows[0]!, ...updates };
              return [eventRows[0]];
            }
            if (table === projectSessions) {
              sessionRows[0] = { ...sessionRows[0]!, ...updates };
              return [sessionRows[0]];
            }
            return [];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === projectTriggers) triggerRows = [];
      },
    }),
  },
}));

const { projectWebhooksApp, projectsApp, isCronTriggerDue, runProjectTriggerSweep } = await import('../projects/index');

function createApp() {
  const app = new Hono();
  app.route('/v1/projects', projectsApp);
  app.route('/v1/webhooks', projectWebhooksApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('project triggers API contract', () => {
  beforeEach(() => resetState());

  test('creates, lists, patches, and deletes webhook triggers without echoing secrets', async () => {
    const app = createApp();
    const createRes = await app.request(`/v1/projects/${PROJECT_ID}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'webhook',
        config: { secret: 'hook-secret', provider: 'local_docker' },
        agent_name: 'triage',
        prompt_template: 'Handle {{ body.action }}',
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.config.secret).toBeUndefined();
    expect(created.config.has_secret).toBe(true);
    expect(triggerRows[0]?.config).toMatchObject({ secret: 'hook-secret' });

    const listRes = await app.request(`/v1/projects/${PROJECT_ID}/triggers`);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);

    const getRes = await app.request(`/v1/projects/${PROJECT_ID}/triggers/${TRIGGER_ID}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({
      trigger_id: TRIGGER_ID,
      config: { has_secret: true },
    });

    const patchRes = await app.request(`/v1/projects/${PROJECT_ID}/triggers/${TRIGGER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, prompt_template: 'Updated {{ body.action }}' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.enabled).toBe(false);
    expect(patched.prompt_template).toBe('Updated {{ body.action }}');

    const deleteRes = await app.request(`/v1/projects/${PROJECT_ID}/triggers/${TRIGGER_ID}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(triggerRows).toHaveLength(0);
  });

  test('rejects unsigned webhook fires before creating an event or branch', async () => {
    triggerRows.push(triggerRow());
    const app = createApp();
    const rawBody = JSON.stringify({ action: 'opened' });

    const missing = await app.request(`/v1/webhooks/${TRIGGER_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    expect(missing.status).toBe(401);

    const bad = await app.request(`/v1/webhooks/${TRIGGER_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody, 'wrong-secret'),
      },
      body: rawBody,
    });
    expect(bad.status).toBe(401);
    expect(eventRows).toHaveLength(0);
    expect(branchCreateCalls).toBe(0);
  });

  test('fires a valid webhook through the normal session creation path', async () => {
    triggerRows.push(triggerRow({ config: { secret: 'hook-secret', provider: 'local_docker' } }));
    const app = createApp();
    const rawBody = JSON.stringify({ action: 'opened', issue: { title: 'Login bug' } });

    const res = await app.request(`/v1/webhooks/${TRIGGER_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('fired');
    expect(body.event.status).toBe('fired');
    expect(body.event.rendered_prompt).toBe('Handle opened: Login bug');
    expect(body.session.metadata).toMatchObject({
      trigger_id: TRIGGER_ID,
      trigger_type: 'webhook',
      initial_prompt: 'Handle opened: Login bug',
    });
    expect(branchCreateCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBe('Handle opened: Login bug');
    expect(lastProvisionEnv?.KORTIX_CONNECTOR_BASE_URL).toContain('/v1/router/connectors');
    expect(lastProvisionEnv?.KORTIX_CONNECTOR_TOKEN).toBeTruthy();
  });

  test('queues webhook fires when project provisioning backpressure is saturated', async () => {
    triggerRows.push(triggerRow());
    provisioningSessionCount = 3;
    const app = createApp();
    const rawBody = JSON.stringify({ action: 'opened', issue: { title: 'Queue me' } });

    const res = await app.request(`/v1/webhooks/${TRIGGER_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kortix-Signature': sign(rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.reason).toBe('project provisioning backpressure');
    expect(eventRows[0]?.status).toBe('queued');
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });

  test('detects due cron triggers and fires them through the normal session path', async () => {
    const lastFiredAt = new Date('2026-01-01T00:00:00Z');
    triggerRows.push(triggerRow({
      type: 'cron',
      config: { cron: '* * * * *', provider: 'local_docker' },
      promptTemplate: 'Scheduled {{ cron.schedule }}',
      lastFiredAt,
      createdAt: lastFiredAt,
    }));

    expect(isCronTriggerDue(triggerRows[0]!, new Date('2026-01-01T00:02:00Z'))).toBe(true);
    const result = await runProjectTriggerSweep(new Date('2026-01-01T00:02:00Z'));

    expect(result).toMatchObject({ scanned: 1, fired: 1, queued: 0, failed: 0 });
    expect(eventRows[0]?.status).toBe('fired');
    expect(eventRows[0]?.renderedPrompt).toBe('Scheduled * * * * *');
    expect(sessionRows[0]?.metadata).toMatchObject({ trigger_type: 'cron' });
    expect(branchCreateCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sandboxProvisionCalls).toBe(1);
    expect(lastProvisionEnv?.KORTIX_INITIAL_PROMPT).toBe('Scheduled * * * * *');
  });

  test('cron backpressure queues once and advances last_fired_at', async () => {
    const lastFiredAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T00:02:00Z');
    triggerRows.push(triggerRow({
      type: 'cron',
      config: { cron: '* * * * *' },
      promptTemplate: 'Queued {{ cron.schedule }}',
      lastFiredAt,
      createdAt: lastFiredAt,
    }));
    provisioningSessionCount = 3;

    const result = await runProjectTriggerSweep(now);

    expect(result).toMatchObject({ scanned: 1, fired: 0, queued: 1, failed: 0 });
    expect(eventRows[0]?.status).toBe('queued');
    expect(triggerRows[0]?.lastFiredAt?.toISOString()).toBe(now.toISOString());
    expect(branchCreateCalls).toBe(0);
    expect(sandboxProvisionCalls).toBe(0);
  });
});
