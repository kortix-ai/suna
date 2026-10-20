/**
 * Real-PostgreSQL integration test: a session whose model cannot serve moves to
 * the fallback that answered, once, and moves back at a turn end when the
 * original model can serve again.
 *
 * The servability probe is mocked (it resolves real provider credentials);
 * the session writes, the compare-and-set guards and the audit events run
 * unmocked against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { auditEvents, projectSessions, sessionLifecycleCommands } from '@kortix/db';
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

const { switchSessionToFallback, forgetFallbackSwitch } = await import('../llm-gateway/resolution/session-model-fallback');
const { revertSessionModelFallback } = await import('../projects/lib/session-model-fallback-revert');

const SOL = 'kortix/codex/gpt-6.1-sol';
const DEEPSEEK = 'kortix/deepseek-v4.1-flash';
const GLM = 'kortix/glm-5.3-flash';

let project: SeededProject;

async function seedSession(metadata: Record<string, unknown>, promptModel?: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
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

const change = (sessionId: string, from = SOL, to = DEEPSEEK) => ({
  sessionId,
  projectId: project.project_id,
  accountId: project.account_id,
  from,
  to,
  reason: 'provider_pool_rate_limited',
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
    });

    // Every later request of the held route: no second write, no second audit.
    expect(await switchSessionToFallback(change(sessionId), 2_000)).toBe(false);
    forgetFallbackSwitch(sessionId);
    expect(await switchSessionToFallback(change(sessionId), 3_000)).toBe(false);
    expect((await metadataOf(sessionId)).opencode_model_fallback_at).toBe(1_000);
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
    for (const key of ['opencode_model_fallback_from', 'opencode_model_fallback_from_source', 'opencode_model_fallback_reason', 'opencode_model_fallback_at']) {
      expect(metadata[key]).toBeUndefined();
    }
    expect(await revertSessionModelFallback(sessionId)).toBeNull();
    expect(await auditCount(sessionId, 'SESSION_MODEL_FALLBACK_REVERTED')).toBe(1);

    // The model rests again: the switch is written again (no stale memo).
    expect(await switchSessionToFallback(change(sessionId), 5_000)).toBe(true);
  });

  test('a default pin moves back as explicit, so the composer ranks it above the fallback prompts', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'default' }, SOL);
    await switchSessionToFallback(change(sessionId), 1_000);
    servable = true;
    expect(await revertSessionModelFallback(sessionId)).toBe(SOL);
    expect((await metadataOf(sessionId)).opencode_model_source).toBe('explicit');
  });

  test('a session no fallback took over is left alone', async () => {
    const sessionId = await seedSession({ opencode_model: SOL, opencode_model_source: 'explicit' });
    servable = true;
    probes.length = 0;
    expect(await revertSessionModelFallback(sessionId)).toBeNull();
    expect(probes).toEqual([]);
  });
});
