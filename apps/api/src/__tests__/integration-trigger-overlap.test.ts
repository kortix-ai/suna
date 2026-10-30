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
