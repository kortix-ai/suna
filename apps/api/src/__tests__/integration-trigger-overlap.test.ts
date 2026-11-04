/**
 * Integration test (real PostgreSQL): trigger overlap (KRTX-1721).
 *
 * A fresh-mode trigger with `overlap: skip` does not start a run while its
 * previous run is still active: a session it created is still being set up,
 * holds a live turn, or its create is still queued. `skip` is the default for
 * a cron trigger; every other type defaults to `allow`. A person's fire is
 * never held. Session creation is stubbed; every query is real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, projectSessions, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

// A create that ran would land here: a held fire must never reach it.
const creates: string[] = [];
const realSessions = await import('../projects/lib/sessions');
// The managed lineup is what Platinum Inference lists; tests never call
// Platinum, so seed the synthetic lineup (fixtures/managed-lineup.ts).
const { __setManagedLineupForTest } = await import('../llm-gateway/models/managed-models');
const { TEST_MANAGED_LINEUP } = await import('./fixtures/managed-lineup');
__setManagedLineupForTest(TEST_MANAGED_LINEUP);

mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { metadata?: Record<string, unknown> }) => {
    creates.push(String(input.metadata?.trigger_slug));
    return { error: { status: 402, body: { error: 'stubbed create', code: 'insufficient_credits' } } };
  },
}));

const { fireGitTrigger } = await import('../projects/lib/trigger-fire');

const AUTHOR = crypto.randomUUID();
let project: SeededProject;

function spec(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: `Trigger ${slug}`,
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Run it.',
    cron: '0 * * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    ...extra,
  } as const;
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
  return row!;
}

/** A session `slug` created, in `status`, optionally with a box and a live turn. */
async function seedTriggerSession(slug: string, input: { status: string; box?: 'live-turn' | 'idle'; createdAt?: Date; deleted?: boolean }) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: AUTHOR,
    status: input.status as never,
    metadata: { trigger_slug: slug, trigger_kind: 'git', ...(input.deleted ? { deletedAt: new Date().toISOString() } : {}) },
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  if (input.box) {
    const sandboxId = crypto.randomUUID();
    const token = `tok-${sandboxId}`;
    await db.insert(sessionSandboxes).values({
      sandboxId,
      sessionId,
      accountId: project.account_id,
      projectId: project.project_id,
      externalId: `ext-${sandboxId}`,
      status: 'active',
      metadata: input.box === 'live-turn' ? { activeTurns: { [token]: { token, state: 'active', runtimeSessionId: 'ses_root' } } } : {},
    });
  }
  return sessionId;
}

async function fire(triggerSpec: Record<string, unknown>, deliberate = false) {
  creates.length = 0;
  return fireGitTrigger({ spec: triggerSpec as never, project: await projectRow(), payload: {}, renderedPrompt: 'Run it.', source: deliberate ? 'manual' : 'cron', deliberate });
}

beforeAll(async () => {
  project = await seedProject('trigger-overlap');
  // A trigger's sessions run as the account owner: without one, no fire reaches the create.
  await insertIntoView(db, accountMembers, [{ userId: AUTHOR, accountId: project.account_id, accountRole: 'owner' }]);
});

// Each test starts from an empty project: seeded provisioning sessions would
// otherwise reach the project's create backpressure (3) and queue later creates.
afterEach(async () => {
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  // The sandbox identity guard allows a delete only once its session is deleted.
  await db.execute(sql`UPDATE kortix.project_sessions SET metadata = metadata || '{"deletedAt":"2026-10-20T00:00:00.000Z"}'::jsonb WHERE project_id = ${project.project_id}::uuid`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, project.project_id));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('a fresh cron trigger (overlap: skip by default)', () => {
  test('a session it created that is still being set up holds the fire', async () => {
    const sessionId = await seedTriggerSession('setting-up', { status: 'provisioning' });
    expect(await fire(spec('setting-up'))).toEqual({ status: 'skipped', reason: `overlap: the previous run is still active (session ${sessionId})` });
    expect(creates).toEqual([]);
  });

  test('a session it created whose box holds a live turn holds the fire', async () => {
    const sessionId = await seedTriggerSession('mid-turn', { status: 'running', box: 'live-turn' });
    expect(await fire(spec('mid-turn'))).toEqual({ status: 'skipped', reason: `overlap: the previous run is still active (session ${sessionId})` });
  });

  test('its create still queued in the lifecycle queue holds the fire', async () => {
    const [command] = await db
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'create_session',
        source: 'trigger:cron',
        status: 'queued',
        projectId: project.project_id,
        accountId: project.account_id,
        payload: { metadata: { trigger_slug: 'queued-create', trigger_kind: 'git' } },
      } as never)
      .returning({ commandId: sessionLifecycleCommands.commandId });
    expect(await fire(spec('queued-create'))).toEqual({ status: 'skipped', reason: `overlap: the previous run is still queued (command ${command!.commandId})` });
  });

  test('a finished run does not hold it: an idle box, a failed or deleted session, or a session older than 24 hours', async () => {
    await seedTriggerSession('finished', { status: 'running', box: 'idle' });
    await seedTriggerSession('finished', { status: 'failed' });
    await seedTriggerSession('finished', { status: 'provisioning', deleted: true });
    await seedTriggerSession('finished', { status: 'running', box: 'live-turn', createdAt: new Date(Date.now() - 25 * 60 * 60_000) });
    const result = await fire(spec('finished'));
    expect(result.status).not.toBe('skipped');
    expect(creates).toEqual(['finished']);
  });

  test('a create left running for more than 24 hours does not hold it for good', async () => {
    // A create claimed before inline claims carried a lock stays `running` with
    // no lock; no worker ever settles it.
    await db.insert(sessionLifecycleCommands).values({
      commandType: 'create_session',
      source: 'trigger:cron',
      status: 'running',
      projectId: project.project_id,
      accountId: project.account_id,
      payload: { metadata: { trigger_slug: 'wedged-create', trigger_kind: 'git' } },
      createdAt: new Date(Date.now() - 25 * 60 * 60_000),
    } as never);
    expect((await fire(spec('wedged-create'))).status).not.toBe('skipped');
    expect(creates).toEqual(['wedged-create']);
  });

  test("another trigger's active session does not hold it", async () => {
    await seedTriggerSession('neighbour', { status: 'provisioning' });
    expect((await fire(spec('alone'))).status).not.toBe('skipped');
  });

  test('overlap: allow starts the run anyway', async () => {
    await seedTriggerSession('allowed', { status: 'provisioning' });
    expect((await fire(spec('allowed', { overlap: 'allow' }))).status).not.toBe('skipped');
    expect(creates).toEqual(['allowed']);
  });

  test('a person firing it by hand is not held', async () => {
    await seedTriggerSession('by-hand', { status: 'provisioning' });
    expect((await fire(spec('by-hand'), true)).status).not.toBe('skipped');
    expect(creates).toEqual(['by-hand']);
  });
});

describe('other types (overlap: allow by default)', () => {
  test('a fresh webhook starts a run while its previous run is active, unless it sets overlap: skip', async () => {
    const hook = (extra: Record<string, unknown> = {}) => spec('hook', { type: 'webhook', cron: null, secretEnv: 'HOOK_SECRET', ...extra });
    const sessionId = await seedTriggerSession('hook', { status: 'provisioning' });
    expect((await fire(hook())).status).not.toBe('skipped');
    expect(await fire(hook({ overlap: 'skip' }))).toEqual({ status: 'skipped', reason: `overlap: the previous run is still active (session ${sessionId})` });
  });
});

describe('a cron trigger that re-prompts one session (reuse, pinned, keyed)', () => {
  /** A prompt of `slug` in the queue of a session of that trigger, keyed when `key` is given. */
  async function seedWaitingPrompt(slug: string, input: { status: string; key?: string; createdAt?: Date }) {
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({
      sessionId,
      accountId: project.account_id,
      projectId: project.project_id,
      branchName: `session/${sessionId}`,
      createdBy: AUTHOR,
      status: 'running' as never,
      metadata: { trigger_slug: slug, trigger_kind: 'git', ...(input.key ? { trigger_session_key: input.key } : {}) },
    });
    const [command] = await db
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'continue_session',
        source: 'trigger:cron',
        status: input.status,
        projectId: project.project_id,
        accountId: project.account_id,
        sessionId,
        payload: { text: 'Run it.', triggerSlug: slug },
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      } as never)
      .returning({ commandId: sessionLifecycleCommands.commandId });
    return command!.commandId;
  }

  test('a reuse trigger whose previous prompt still waits is held, so prompts do not stack', async () => {
    const commandId = await seedWaitingPrompt('reuse-tick', { status: 'queued' });
    expect(await fire(spec('reuse-tick', { sessionMode: 'reuse' }))).toEqual({
      status: 'skipped',
      reason: `overlap: the previous prompt is still waiting (command ${commandId})`,
    });
    expect(creates).toEqual([]);
  });

  test('a keyed trigger is held only by a waiting prompt in the session of its own key', async () => {
    const keyed = (key: string) => spec('keyed-tick', { sessionMode: 'keyed', sessionKey: key });
    const commandId = await seedWaitingPrompt('keyed-tick', { status: 'running', key: 'main' });
    expect(await fire(keyed('main'))).toEqual({
      status: 'skipped',
      reason: `overlap: the previous prompt is still waiting (command ${commandId})`,
    });
    expect((await fire(keyed('other'))).status).not.toBe('skipped');
  });

  test('a delivered prompt, a prompt older than 24 hours, overlap: allow, and a person firing by hand are not held', async () => {
    await seedWaitingPrompt('reuse-done', { status: 'succeeded' });
    expect((await fire(spec('reuse-done', { sessionMode: 'reuse' }))).status).not.toBe('skipped');
    await seedWaitingPrompt('reuse-wedged', { status: 'running', createdAt: new Date(Date.now() - 25 * 60 * 60_000) });
    expect((await fire(spec('reuse-wedged', { sessionMode: 'reuse' }))).status).not.toBe('skipped');
    await seedWaitingPrompt('reuse-allowed', { status: 'queued' });
    expect((await fire(spec('reuse-allowed', { sessionMode: 'reuse', overlap: 'allow' }))).status).not.toBe('skipped');
    expect((await fire(spec('reuse-allowed', { sessionMode: 'reuse' }), true)).status).not.toBe('skipped');
  });
});
