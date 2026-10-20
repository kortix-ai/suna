/**
 * Real-PostgreSQL integration test: a session whose model cannot serve moves to
 * the fallback that answered, once, and moves back at a turn end or from the
 * idle sweep when the original model can serve again.
 *
 * The servability probe is mocked (it resolves real provider credentials);
 * the session writes, the compare-and-set guards and the audit events run
 * unmocked against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { auditEvents, projectSessions, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

let servable = false;
const probes: Array<{ model: string; restingIsServable?: boolean }> = [];
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async (input: { model: string; restingIsServable?: boolean }) => {
    probes.push({ model: input.model, restingIsServable: input.restingIsServable });
    return servable;
  },
  resolveEffectiveModel: async () => ({ model: null, source: 'platform' as const }),
  resolveDefaultModelForPrincipal: async () => null,
  invalidateAccountModelDefaults: () => {},
}));

const { switchSessionToFallback } = await import('../llm-gateway/resolution/session-model-fallback');
const { clearRestoredModelPin, revertSessionModelFallback, revertIdleSessionFallbacks } = await import('../projects/lib/session-model-fallback-revert');

const SOL = 'kortix/codex/gpt-6.1-sol';
const DEEPSEEK = 'kortix/deepseek-v4.1-flash';
const GLM = 'kortix/glm-5.3-flash';

let project: SeededProject;

async function seedSession(
  metadata: Record<string, unknown>,
  promptModel?: string,
  status: 'running' | 'stopped' = 'stopped',
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    status,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    agentName: 'default',
    createdBy: crypto.randomUUID(),
    metadata,
  });
  if (promptModel) {
    const [providerID, ...rest] = promptModel.split('/');
    await db.insert(sessionLifecycleCommands).values({
      commandType: 'continue_session',
      source: 'test',
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      status: 'succeeded',
      payload: { overrides: { model: { providerID, modelID: rest.join('/') } } },
    });
  }
  return sessionId;
}

async function metadataOf(sessionId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: projectSessions.metadata }).from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

async function auditCount(sessionId: string, action: string): Promise<number> {
  const rows = await db.select().from(auditEvents)
    .where(and(eq(auditEvents.sessionId, sessionId), eq(auditEvents.action, action)));
  return rows.length;
}

const change = (sessionId: string, from = SOL, to = DEEPSEEK, reason = 'provider_pool_rate_limited', holdSeconds = 600) => ({
  sessionId,
  projectId: project.project_id,
  accountId: project.account_id,
  from,
  to,
  reason,
  holdSeconds,
});

beforeAll(async () => {
  process.env.KORTIX_AUDIT_SYNC = '1';
  project = await seedProject('model-fallback');
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('session model fallback', () => {
  test('the first fallback switches the session, records what it stood in for, and audits once', async () => {
    const sessionId = await seedSession({ opencode_model: GLM, opencode_model_source: 'default', name: 'kept' }, SOL);

    expect(await switchSessionToFallback(change(sessionId), 1_000)).toBe(true);
    const metadata = await metadataOf(sessionId);
    expect(metadata).toMatchObject({
      name: 'kept',
      opencode_model: DEEPSEEK,
      opencode_model_source: 'fallback',
      opencode_model_fallback_from: SOL,
      opencode_model_fallback_from_source: 'default',
      opencode_model_fallback_reason: 'provider_pool_rate_limited',
      opencode_model_fallback_at: 1_000,
      opencode_model_fallback_until: 601_000,
    });

    // A later `resolve` failure (another gateway task's own hold): no second
    // switch and no second audit, but `at` moves so the revert waits for it.
    expect(await switchSessionToFallback(change(sessionId), 2_000)).toBe(false);
    expect(await metadataOf(sessionId)).toMatchObject({
      opencode_model: DEEPSEEK,
      opencode_model_fallback_from: SOL,
      opencode_model_fallback_from_source: 'default',
      opencode_model_fallback_at: 2_000,
      opencode_model_fallback_until: 602_000,
    });
    expect(await auditCount(sessionId, 'SESSION_MODEL_FALLBACK')).toBe(1);
  });

  test('a second fallback keeps the original model as the one to return to', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL);
    await switchSessionToFallback(change(sessionId), 1_000);
    // The next prompt carries the fallback; it fails over again.
    await db.update(sessionLifecycleCommands)
      .set({ payload: { overrides: { model: { providerID: 'kortix', modelID: 'deepseek-v4.1-flash' } } } })
      .where(eq(sessionLifecycleCommands.sessionId, sessionId));
    expect(await switchSessionToFallback(change(sessionId, DEEPSEEK, GLM), 2_000)).toBe(true);
    expect(await metadataOf(sessionId)).toMatchObject({
      opencode_model: GLM,
      opencode_model_fallback_from: SOL,
      opencode_model_fallback_from_source: 'explicit',
    });
  });

  test("a request for another model than the session's prompt does not switch it", async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, GLM);
    expect(await switchSessionToFallback(change(sessionId), 1_000)).toBe(false);
    expect((await metadataOf(sessionId)).opencode_model).toBe(SOL);
  });

  test('with no prompt model, only a session pinned to the failing model switches', async () => {
    const pinned = await seedSession({ opencode_model: SOL });
    const other = await seedSession({ opencode_model: GLM });
    expect(await switchSessionToFallback(change(pinned), 1_000)).toBe(true);
    expect(await switchSessionToFallback(change(other), 1_000)).toBe(false);
  });

  test('at a turn end the session stays while the original cannot serve, then moves back once', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL);
    await switchSessionToFallback(change(sessionId), 1_000);

    servable = false;
    probes.length = 0;
    expect(await revertSessionModelFallback(sessionId)).toBeNull();
    expect(probes).toEqual([{ model: SOL, restingIsServable: false }]);
    expect((await metadataOf(sessionId)).opencode_model).toBe(DEEPSEEK);

    servable = true;
    expect(await revertSessionModelFallback(sessionId)).toBe(SOL);
    const metadata = await metadataOf(sessionId);
    expect(metadata.opencode_model).toBe(SOL);
    expect(metadata.opencode_model_source).toBe('explicit');
    expect(metadata.opencode_model_restored).toBe(true);
    for (const key of ['opencode_model_fallback_from', 'opencode_model_fallback_from_source', 'opencode_model_fallback_reason', 'opencode_model_fallback_at', 'opencode_model_fallback_until']) {
      expect(metadata[key]).toBeUndefined();
    }
    expect(await revertSessionModelFallback(sessionId)).toBeNull();
    expect(await auditCount(sessionId, 'SESSION_MODEL_FALLBACK_REVERTED')).toBe(1);

    // The model rests again: the switch is written again (no stale memo).
    expect(await switchSessionToFallback(change(sessionId), 5_000)).toBe(true);
  });

  test('a default pin moves back with its own source, marked restored until the next prompt runs on it', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'project' }, SOL);
    await switchSessionToFallback(change(sessionId), 1_000);
    servable = true;
    expect(await revertSessionModelFallback(sessionId)).toBe(SOL);
    expect(await metadataOf(sessionId)).toMatchObject({ opencode_model: SOL, opencode_model_source: 'project', opencode_model_restored: true });

    // The next prompt carries the pin: the marker goes, the source stays.
    await clearRestoredModelPin(sessionId);
    const metadata = await metadataOf(sessionId);
    expect(metadata.opencode_model_restored).toBeUndefined();
    expect(metadata).toMatchObject({ opencode_model: SOL, opencode_model_source: 'project' });
  });

  test('a pin with no source moves back with no source', async () => {
    const sessionId = await seedSession({ opencode_model: SOL });
    await switchSessionToFallback(change(sessionId), 1_000);
    servable = true;
    expect(await revertSessionModelFallback(sessionId)).toBe(SOL);
    const metadata = await metadataOf(sessionId);
    expect(metadata.opencode_model).toBe(SOL);
    expect(metadata.opencode_model_source).toBeUndefined();
  });

  test("a resting pool moves back when the gateway's hold ends: the pool's reset when it is shorter than 10 min", async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL);
    await switchSessionToFallback(change(sessionId, SOL, DEEPSEEK, 'provider_pool_rate_limited', 120), 1_000_000);
    servable = true;
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 119_000)).toBeNull();
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 120_000)).toBe(SOL);
  });

  test('the session stays on the fallback while the gateway still holds the route', async () => {
    // The gateway holds a resting route up to MAX_HOLD_SECONDS from the switch
    // (pipeline/route-memory.ts) and answers the original model with the
    // fallback until then: moving back earlier shows a model that does not answer.
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL);
    await switchSessionToFallback(change(sessionId), 1_000_000);
    servable = true;
    probes.length = 0;
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 599_000)).toBeNull();
    expect(probes).toEqual([]);
    // Another gateway task holds the route from its own failure: the wait restarts.
    await switchSessionToFallback(change(sessionId), 1_300_000);
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 600_000)).toBeNull();
    expect(await revertSessionModelFallback(sessionId, 1_300_000 + 600_000)).toBe(SOL);
  });

  test('a login that needs reconnecting moves back after its 60 s hold, not the 10 min one', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL);
    await switchSessionToFallback(change(sessionId, SOL, DEEPSEEK, 'provider_reauth_required', 60), 1_000_000);
    servable = true;
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 59_000)).toBeNull();
    expect(await revertSessionModelFallback(sessionId, 1_000_000 + 60_000)).toBe(SOL);
  });

  test('a session no fallback took over is left alone', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' });
    servable = true;
    probes.length = 0;
    expect(await revertSessionModelFallback(sessionId)).toBeNull();
    expect(probes).toEqual([]);
  });

  test('the idle sweep moves back a live idle session, never a busy or a stopped one', async () => {
    const idle = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL, 'running');
    const busy = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL, 'running');
    const stopped = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' }, SOL, 'stopped');
    for (const sessionId of [idle, busy, stopped]) await switchSessionToFallback(change(sessionId), 1_000);
    await db.insert(sessionSandboxes).values({
      sandboxId: crypto.randomUUID(),
      sessionId: busy,
      accountId: project.account_id,
      projectId: project.project_id,
      metadata: { activeTurns: { t1: { token: 't1', state: 'active' } } },
    });
    servable = true;
    await revertIdleSessionFallbacks();
    expect((await metadataOf(idle)).opencode_model).toBe(SOL);
    expect((await metadataOf(busy)).opencode_model).toBe(DEEPSEEK);
    expect((await metadataOf(stopped)).opencode_model).toBe(DEEPSEEK);
  });
});
