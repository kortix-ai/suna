/**
 * Real-PostgreSQL integration test: a session pinned to a RETIRED managed
 * model is re-pointed at boot instead of dying on its next turn.
 *
 * Evidence (2026-09-28 sweep of 9 real sessions in one project): 4/5 turn
 * failures were exactly this — a session pinned to a model id the runtime
 * lineup no longer serves. `resolveCandidates` now names the cause distinctly
 * (`model_retired`, resolve-candidates.test.ts); this suite proves the
 * SESSION itself is moved off the dead id at boot, before that error can ever
 * fire — at the one chokepoint every provisioning path shares
 * (`buildSessionSandboxEnvVars`, projects/lib/sessions.ts).
 *
 * The runtime-servable lineup and the project's resolved default are mocked
 * (`SERVED_MANAGED_MODELS` depends on real OpenRouter/Bedrock transport
 * credentials this local test environment does not carry); the DB write, the
 * audit event, and env building all run unmocked against real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { auditEvents, projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const managedModel = (id: string) => ({
  id,
  name: id,
  upstreamModelId: `vendor/${id}`,
  transport: 'openrouter' as const,
  pricingRef: `vendor/${id}`,
  tier: 'balanced' as const,
  vision: true,
  limit: { context: 200_000, output: 32_000 },
  openrouterProvider: { only: ['x'], allow_fallbacks: false, zdr: true as const, data_collection: 'deny' as const },
});

mock.module('../llm-gateway/models/served-managed-models', () => ({
  SERVED_MANAGED_MODELS: [managedModel('deepseek-v4.1-flash'), managedModel('glm-5.3-flash')],
  platformDefaultModelId: () => 'glm-5.3-flash',
}));

let projectDefaultModel: string | null = 'glm-5.3-flash';
mock.module('../llm-gateway/resolution/default-model', () => ({
  resolveEffectiveModel: async () => ({ model: projectDefaultModel, source: 'project' as const }),
  isModelServableForAccount: async () => true,
  invalidateAccountModelDefaults: () => {},
}));

const { repointRetiredSessionModel } = await import('../llm-gateway/resolution/session-model-repoint');
const { buildSessionSandboxEnvVars } = await import('../projects/lib/sessions');

let project: SeededProject;

async function seedSessionWithModel(model: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    agentName: 'default',
    metadata: { opencode_model: model },
  });
  return sessionId;
}

beforeAll(async () => {
  // No git checkout: defaultBranch/manifestPath empty keeps buildSessionSandboxEnvVars
  // off the git-dependent compiled-agent-config path (same recipe as
  // integration-session-env-grants.test.ts), which keeps this suite's real-DB
  // assertions deterministic.
  project = await seedProject('model-repoint');
});

afterAll(async () => {
  // removeSeeded deletes the project row; project_sessions FKs cascade.
  await removeSeeded([project]);
});

describe('repointRetiredSessionModel', () => {
  test('a retired id with a servable declared successor is re-pointed to it, durably and audibly', async () => {
    const sessionId = await seedSessionWithModel('kortix/deepseek-v4-flash-0731');

    const nextRef = await repointRetiredSessionModel('kortix/deepseek-v4-flash-0731', {
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      userId: crypto.randomUUID(),
      agentName: 'default',
      freeModelsOnly: false,
      metadata: { opencode_model: 'kortix/deepseek-v4-flash-0731' },
    });
    expect(nextRef).toBe('kortix/deepseek-v4.1-flash');

    const [row] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.opencode_model).toBe('kortix/deepseek-v4.1-flash');
    expect(metadata.opencode_model_source).toBe('repointed');
    expect(metadata.opencode_model_repointed_from).toBe('deepseek-v4-flash-0731');

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.sessionId, sessionId), eq(auditEvents.action, 'SESSION_MODEL_REPOINTED')))
      .limit(1);
    expect(audit).toBeDefined();
    expect((audit?.metadata as Record<string, unknown> | null)?.reason).toBe('successor');
  });

  test('a retired id with NO declared successor falls back to the project default', async () => {
    const sessionId = await seedSessionWithModel('kortix/grok-4.6');

    const nextRef = await repointRetiredSessionModel('kortix/grok-4.6', {
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      userId: crypto.randomUUID(),
      agentName: 'default',
      freeModelsOnly: false,
      metadata: { opencode_model: 'kortix/grok-4.6' },
    });
    expect(nextRef).toBe('kortix/glm-5.3-flash');

    const [row] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.opencode_model_source).toBe('repointed');
  });

  // REVERSED DELIBERATELY, 2026-09-28. This test previously asserted that a
  // retired id with no successor and no project default is LEFT UNTOUCHED, so
  // the turn-time `model_retired` error could name the real cause instead of
  // this function inventing a substitute.
  //
  // That reasoning holds only if a human then picks a new model. Measured on a
  // real dev project: 20 of 238 sessions were pinned to `glm-5.2` — retired, no
  // declared successor — in a project that had never set a default model. Every
  // one of them was permanently unable to complete a turn. The lineup rotation
  // was OUR decision, not the user's, so leaving their session dead is our
  // failure and not their choice.
  //
  // The substitution is NOT silent, which is what makes it acceptable: the write
  // records `opencode_model_source: 'repointed'` and
  // `opencode_model_repointed_from`, both already returned by the session read
  // routes, plus an audit event naming `platform_default` as the reason.
  test('a retired id with no successor falls back to the PLATFORM default', async () => {
    projectDefaultModel = null;
    const sessionId = await seedSessionWithModel('kortix/grok-4.6');

    const nextRef = await repointRetiredSessionModel('kortix/grok-4.6', {
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      userId: crypto.randomUUID(),
      agentName: 'default',
      freeModelsOnly: false,
      metadata: { opencode_model: 'kortix/grok-4.6' },
    });
    // Whatever the platform default is, the session must not stay on a model
    // that cannot serve a turn.
    expect(nextRef).not.toBe('kortix/grok-4.6');

    const [row] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.opencode_model_source).toBe('repointed');
    expect(metadata.opencode_model_repointed_from).toBe('grok-4.6');
    projectDefaultModel = 'glm-5.3-flash';
  });

  test('a non-retired model is left untouched — no DB write at all', async () => {
    const sessionId = await seedSessionWithModel('kortix/glm-5.3-flash');
    const [before] = await db
      .select({ updatedAt: projectSessions.updatedAt })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);

    const nextRef = await repointRetiredSessionModel('kortix/glm-5.3-flash', {
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      userId: crypto.randomUUID(),
      agentName: 'default',
      freeModelsOnly: false,
      metadata: { opencode_model: 'kortix/glm-5.3-flash' },
    });
    expect(nextRef).toBe('kortix/glm-5.3-flash');

    const [after] = await db
      .select({ updatedAt: projectSessions.updatedAt })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
  });
});

// The actual chokepoint: every session-open/restart/resume path builds the
// sandbox's env through this one function. It must re-point the retired pin
// BEFORE the box ever boots, so the session runs on the first turn instead of
// throwing — the exact "gets re-pointed and runs" contract.
describe('buildSessionSandboxEnvVars — session open re-points a retired pin before the box ever boots', () => {
  test('the returned KORTIX_OPENCODE_MODEL is the re-pointed replacement, not the dead id', async () => {
    const sessionId = await seedSessionWithModel('kortix/deepseek-v4-flash-0731');

    const env = await buildSessionSandboxEnvVars({
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      userId: crypto.randomUUID(),
      repoUrl: 'https://example.test/model-repoint.git',
      baseRef: 'main',
      agentName: 'default',
      opencodeModel: 'kortix/deepseek-v4-flash-0731',
      llmGatewayEnabled: true,
    });

    expect(env.KORTIX_OPENCODE_MODEL).toBe('kortix/deepseek-v4.1-flash');
  });

  test('llmGatewayEnabled: false (native mode) never re-points — the pin is not a managed id there', async () => {
    const sessionId = await seedSessionWithModel('kortix/deepseek-v4-flash-0731');

    const env = await buildSessionSandboxEnvVars({
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      userId: crypto.randomUUID(),
      repoUrl: 'https://example.test/model-repoint.git',
      baseRef: 'main',
      agentName: 'default',
      opencodeModel: 'kortix/deepseek-v4-flash-0731',
      llmGatewayEnabled: false,
    });

    expect(env.KORTIX_OPENCODE_MODEL).toBe('kortix/deepseek-v4-flash-0731');
  });
});
