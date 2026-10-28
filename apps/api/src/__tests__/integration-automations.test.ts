/**
 * Integration test (real PostgreSQL): runtime automations on the trigger tables
 * (`projects/lib/automations.ts`). Each case is one of the places that used to
 * assume an automation lives in kortix.yaml:
 *   1. the fire path dispatches a non-schedule session target to the session;
 *   2. the webhook receiver finds a runtime webhook automation;
 *   3. connector subscriptions reconcile runtime event automations;
 *   4. a merged change request fires the automations it matches, once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectSessions, projectTriggerExecutions, projectTriggerRuntime, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { newAutomationId, parseRuntimeAutomationBody, runtimeAutomationSpec, runtimeWebhookSpec } from '../projects/lib/automations';
import { fireChangeRequestMergedAutomations } from '../projects/lib/change-request-automations';
import { countActiveSessionReminders, insertSessionReminder } from '../projects/lib/session-reminders';
import { fireGitTrigger } from '../projects/lib/trigger-fire';
import { withRuntimeEventSpecs } from '../projects/trigger-events/subscriptions';
import type { GitTriggerSpec } from '../projects/triggers';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const CR = crypto.randomUUID();

async function seedSession(): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `automation-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    metadata: {},
  });
  return sessionId;
}

/** Store a session-target automation the way `POST /automations` does. */
async function seedSessionAutomation(sessionId: string, body: Record<string, unknown>): Promise<GitTriggerSpec> {
  const now = new Date();
  const parsed = parseRuntimeAutomationBody({ ...body, target: { session_id: sessionId } }, now);
  if ('error' in parsed) throw new Error(parsed.error);
  const spec = runtimeAutomationSpec({ id: newAutomationId(), body: parsed, agent: 'kortix', now });
  if ('error' in spec) throw new Error(spec.error);
  await insertSessionReminder({ projectId: PROJECT, spec, createdBy: OWNER, firstFireAt: null, now });
  return spec;
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT));
  return row!;
}

async function commandsOf(sessionId: string) {
  return db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'automations-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'automations',
    repoUrl: 'https://example.com/automations.git',
    metadata: { experimental: { reminders: true } },
  });
  await insertIntoView(db, accountMembers, { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('runtime automations', () => {
  test('a webhook into a session queues its rendered prompt into that session and counts as active', async () => {
    const sessionId = await seedSession();
    const spec = await seedSessionAutomation(sessionId, { prompt: 'Build {{ body.ref }}', source: { type: 'webhook', secret_env: 'CI_SECRET' } });
    expect(await countActiveSessionReminders(PROJECT, sessionId)).toBe(1);

    const result = await fireGitTrigger({
      spec,
      project: await projectRow(),
      payload: { body: { ref: 'main' } },
      renderedPrompt: 'Build main',
      source: 'webhook',
      idempotencyKey: `test:${spec.slug}`,
    });

    expect(result).toMatchObject({ status: 'queued', sessionId, reason: 'prompt queued for delivery' });
    const [command] = await commandsOf(sessionId);
    expect(command?.source).toBe('trigger:reminder');
    const text = JSON.stringify(command?.payload);
    expect(text).toContain(`[REMINDER ${spec.slug} — recurring automation (webhook) on this session`);
    expect(text).toContain('Build main');
    expect(text).not.toContain('{{ body.ref }}');
    // No session was created: the session target never starts one.
    expect((await db.select().from(projectSessions).where(eq(projectSessions.projectId, PROJECT))).length).toBe(1);
  });

  test('the webhook receiver finds a runtime webhook automation, and reads pause from the row', async () => {
    const sessionId = await seedSession();
    const spec = await seedSessionAutomation(sessionId, { prompt: 'x', source: { type: 'webhook', secret_env: 'CI_SECRET' } });

    expect(await runtimeWebhookSpec(PROJECT, spec.slug)).toMatchObject({ slug: spec.slug, type: 'webhook', secretEnv: 'CI_SECRET', enabled: true });
    await db.update(projectTriggerRuntime).set({ enabled: false }).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, spec.slug)));
    expect((await runtimeWebhookSpec(PROJECT, spec.slug))?.enabled).toBe(false);
    // A manifest slug is never looked up here.
    expect(await runtimeWebhookSpec(PROJECT, 'nightly')).toBeNull();
  });

  test('connector subscriptions reconcile runtime event automations next to the manifest ones', async () => {
    const event: GitTriggerSpec = {
      slug: newAutomationId(), path: '', name: 'pr', type: 'event', agent: 'kortix', model: null, enabled: true,
      promptTemplate: 'x', cron: null, runAt: null, timezone: 'UTC', secretEnv: null, sessionMode: 'fresh',
      pinnedSessionId: null, sessionKey: null, filter: null,
      event: { connector: 'github', type: 'GITHUB_PULL_REQUEST_EVENT', config: {} },
    };
    await db.insert(projectTriggerRuntime).values({
      projectId: PROJECT, slug: event.slug, triggerType: 'event', enabled: true,
      scheduleSpec: event as unknown as Record<string, unknown>,
    });
    const manifest = { ...event, slug: 'manifest-pr', path: 'kortix.yaml#triggers.manifest-pr' };

    const merged = await withRuntimeEventSpecs(PROJECT, [manifest]);
    expect(merged.map((s) => s.slug).sort()).toEqual([event.slug, 'manifest-pr'].sort());
    // A row the caller already passed is not added twice.
    expect((await withRuntimeEventSpecs(PROJECT, [event])).filter((s) => s.slug === event.slug)).toHaveLength(1);
  });

  test('a merged change request wakes the session that waits on it, once', async () => {
    const sessionId = await seedSession();
    const spec = await seedSessionAutomation(sessionId, {
      prompt: 'CR #{{ change_request.number }} merged into {{ change_request.base_ref }}',
      source: { type: 'change_request', cr_id: CR },
    });
    const other = await seedSession();
    await seedSessionAutomation(other, { prompt: 'never', source: { type: 'change_request', cr_id: crypto.randomUUID() } });
    const project = await projectRow();
    const cr = { cr_id: CR, number: 7, title: 'Fix', base_ref: 'main', head_ref: 'fix', merge_commit_sha: 'abc' };

    expect(await fireChangeRequestMergedAutomations(project, [cr])).toBe(1);
    // A retried hook for the same merge queues nothing new (one key per merge and automation).
    await fireChangeRequestMergedAutomations(project, [cr]);

    const commands = await commandsOf(sessionId);
    expect(commands).toHaveLength(1);
    const text = JSON.stringify(commands[0]?.payload);
    expect(text).toContain(`[REMINDER ${spec.slug} — one-time automation (change request merged) on this session`);
    expect(text).toContain('CR #7 merged into main');
    expect(await commandsOf(other)).toHaveLength(0);
    const runs = await db.select().from(projectTriggerExecutions).where(and(eq(projectTriggerExecutions.projectId, PROJECT), eq(projectTriggerExecutions.slug, spec.slug)));
    expect(runs.map((run) => run.source)).toEqual(['change_request', 'change_request']);
    expect(runs.map((run) => run.status).sort()).toEqual(['skipped', 'succeeded']);
  });
});
