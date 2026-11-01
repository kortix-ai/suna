/**
 * Integration test (real PostgreSQL): runtime triggers on the trigger tables
 * (`projects/lib/runtime-triggers.ts`). Each case is one of the places that used to
 * assume a trigger lives in kortix.yaml:
 *   1. the fire path dispatches a non-schedule session target to the session;
 *   2. the webhook receiver finds a runtime webhook trigger;
 *   3. connector subscriptions reconcile runtime event triggers;
 *   4. a merged change request fires the triggers it matches, once;
 *   5. a kortix.yaml `type: change_request` trigger fires on a matching merge.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectSessions, projectTriggerExecutions, projectTriggerRuntime, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { newRuntimeTriggerId, parseRuntimeTriggerBody, runtimeTriggerSpec, runtimeWebhookSpec } from '../projects/lib/runtime-triggers';
import { fireChangeRequestMergedTriggers } from '../projects/lib/change-request-triggers';
import { countActiveSessionReminders, insertSessionReminder } from '../projects/lib/session-reminders';
import { fireGitTrigger } from '../projects/lib/trigger-fire';
import { withRuntimeEventSpecs } from '../projects/trigger-events/subscriptions';
import { reconcileProjectTriggerRuntime } from '../projects/trigger-runtime-catalog';
import { type GitTriggerSpec, extractTriggers, parseManifestString } from '../projects/triggers';
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
    branchName: `trigger-${sessionId.slice(0, 8)}`,
    createdBy: OWNER,
    metadata: {},
  });
  return sessionId;
}

/** Store a session-target trigger the way `POST /triggers/runtime` does. */
async function seedSessionTrigger(sessionId: string, body: Record<string, unknown>): Promise<GitTriggerSpec> {
  const now = new Date();
  const parsed = parseRuntimeTriggerBody({ ...body, target: { session_id: sessionId } }, now);
  if ('error' in parsed) throw new Error(parsed.error);
  const spec = runtimeTriggerSpec({ id: newRuntimeTriggerId(), body: parsed, agent: 'kortix', now });
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
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'runtime-triggers-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'runtime-triggers',
    repoUrl: 'https://example.com/runtime-triggers.git',
    metadata: { experimental: { reminders: true } },
  });
  await insertIntoView(db, accountMembers, { accountId: ACCOUNT, userId: OWNER, accountRole: 'owner' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('runtime triggers', () => {
  test('a webhook into a session queues its rendered prompt into that session and counts as active', async () => {
    const sessionId = await seedSession();
    const spec = await seedSessionTrigger(sessionId, { prompt: 'Build {{ body.ref }}', source: { type: 'webhook', secret_env: 'CI_SECRET' } });
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
    expect(text).toContain(`[REMINDER ${spec.slug} — recurring trigger (webhook) on this session`);
    expect(text).toContain('Build main');
    expect(text).not.toContain('{{ body.ref }}');
    // No session was created: the session target never starts one.
    expect((await db.select().from(projectSessions).where(eq(projectSessions.projectId, PROJECT))).length).toBe(1);
  });

  test('the webhook receiver finds a runtime webhook trigger, and reads pause from the row', async () => {
    const sessionId = await seedSession();
    const spec = await seedSessionTrigger(sessionId, { prompt: 'x', source: { type: 'webhook', secret_env: 'CI_SECRET' } });

    expect(await runtimeWebhookSpec(PROJECT, spec.slug)).toMatchObject({ slug: spec.slug, type: 'webhook', secretEnv: 'CI_SECRET', enabled: true });
    await db.update(projectTriggerRuntime).set({ enabled: false }).where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, spec.slug)));
    expect((await runtimeWebhookSpec(PROJECT, spec.slug))?.enabled).toBe(false);
    // A manifest slug is never looked up here.
    expect(await runtimeWebhookSpec(PROJECT, 'nightly')).toBeNull();
  });

  test('connector subscriptions reconcile runtime event triggers next to the manifest ones', async () => {
    const event: GitTriggerSpec = {
      slug: newRuntimeTriggerId(), path: '', name: 'pr', type: 'event', agent: 'kortix', model: null, enabled: true,
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
    const spec = await seedSessionTrigger(sessionId, {
      prompt: 'CR #{{ change_request.number }} merged into {{ change_request.base_ref }}',
      source: { type: 'change_request', cr_id: CR },
    });
    const other = await seedSession();
    await seedSessionTrigger(other, { prompt: 'never', source: { type: 'change_request', cr_id: crypto.randomUUID() } });
    const project = await projectRow();
    const cr = { cr_id: CR, number: 7, title: 'Fix', base_ref: 'main', head_ref: 'fix', merge_commit_sha: 'abc' };

    expect(await fireChangeRequestMergedTriggers(project, [cr])).toBe(1);
    // A retried hook for the same merge queues nothing new (one key per merge and trigger).
    await fireChangeRequestMergedTriggers(project, [cr]);

    const commands = await commandsOf(sessionId);
    expect(commands).toHaveLength(1);
    const text = JSON.stringify(commands[0]?.payload);
    expect(text).toContain(`[REMINDER ${spec.slug} — one-time trigger (change request merged) on this session`);
    expect(text).toContain('CR #7 merged into main');
    expect(await commandsOf(other)).toHaveLength(0);
    const runs = await db.select().from(projectTriggerExecutions).where(and(eq(projectTriggerExecutions.projectId, PROJECT), eq(projectTriggerExecutions.slug, spec.slug)));
    expect(runs.map((run) => run.source)).toEqual(['change_request', 'change_request']);
    expect(runs.map((run) => run.status).sort()).toEqual(['skipped', 'succeeded']);
  });

  test('a kortix.yaml change_request trigger fires on a merge into its base branch, and only that one', async () => {
    const sessionId = await seedSession();
    const manifest = parseManifestString(
      [
        'project:',
        '  name: runtime-triggers',
        'triggers:',
        '  - slug: merged-main',
        '    type: change_request',
        '    filter: { base: main }',
        '    agent: kortix',
        '    session_mode: pinned',
        `    session_id: ${sessionId}`,
        '    prompt: "CR #{{ change_request.number }} merged into {{ change_request.base_ref }}"',
        '  - slug: merged-release',
        '    type: change_request',
        '    filter: { base: release }',
        '    agent: kortix',
        '    session_mode: pinned',
        `    session_id: ${sessionId}`,
        '    prompt: never',
      ].join('\n'),
    );
    const { specs, errors } = extractTriggers(manifest);
    expect(errors).toEqual([]);
    expect(specs.find((spec) => spec.slug === 'merged-main')).toMatchObject({
      type: 'change_request',
      changeRequest: { crId: null, base: 'main' },
      filter: null,
    });
    await reconcileProjectTriggerRuntime(PROJECT, specs);

    const cr = { cr_id: crypto.randomUUID(), number: 9, title: 'Ship', base_ref: 'main', head_ref: 'ship', merge_commit_sha: 'def' };
    expect(await fireChangeRequestMergedTriggers(await projectRow(), [cr])).toBe(1);

    const runs = await db.select().from(projectTriggerExecutions).where(eq(projectTriggerExecutions.projectId, PROJECT));
    expect(runs.filter((run) => run.slug === 'merged-main').map((run) => run.source)).toEqual(['change_request']);
    expect(runs.filter((run) => run.slug === 'merged-release')).toEqual([]);
    const text = JSON.stringify((await commandsOf(sessionId))[0]?.payload);
    expect(text).toContain('CR #9 merged into main');
  });
});
