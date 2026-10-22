/**
 * Integration test (real local PostgreSQL): a system continuation that names no
 * model runs on the session's last chosen agent/model.
 *
 * Approval resume, connector-connected, secret-submitted and auto-recovery
 * prompts carry no overrides. OpenCode then falls back to the default agent's
 * own `model:` pin, which in a prod session was a raw `codex/gpt-6-sol` the
 * gateway could not serve: "Model not found" right after the user clicked Deny,
 * although every user turn ran on the model picked in the composer.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { buildContinueSessionCommandValues } from '../projects/session-lifecycle';
import { continuationOverrides } from '../projects/session-lifecycle/queued-continue-delivery';
import { db } from '../shared/db';
import {
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

const USER = '00000000-0000-4000-8000-0000000c0de1';
const GLM = { providerID: 'kortix', modelID: 'glm-5.3-flash' };
let project: SeededProject;
let sessionId: string;

beforeAll(async () => {
  project = await seedProject('continue-inherits-model');
  sessionId = await seedSession(project, USER);
});

afterAll(async () => {
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
  await removeSeeded([project]);
});

const enqueue = (source: 'ui' | 'system:approval-resume', minutesAgo: number, overrides?: object) =>
  db.insert(sessionLifecycleCommands).values({
    ...buildContinueSessionCommandValues({
      source,
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      actorUserId: USER,
      text: 'hi',
      ...(overrides ? { overrides } : {}),
    }),
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });

test('a session with no chosen model leaves the continuation untouched', async () => {
  expect(await continuationOverrides(sessionId, undefined)).toBeUndefined();
});

test("a continuation without a model inherits the newest turn's agent, model and variant", async () => {
  await enqueue('ui', 10, { agent: 'main', model: { providerID: 'kortix', modelID: 'old' } });
  await enqueue('ui', 5, { agent: 'main', model: GLM, variant: 'high', directory: '/workspace/x' });
  await enqueue('system:approval-resume', 1);

  expect(await continuationOverrides(sessionId, undefined)).toEqual({
    agent: 'main',
    model: GLM,
    variant: 'high',
  });
});

test('a continuation that names its own model keeps it', async () => {
  const own = { model: { providerID: 'kortix', modelID: 'trigger-model' } };
  expect(await continuationOverrides(sessionId, own)).toBe(own);
});

test('explicit nulls in the continuation do not erase the inherited pick', async () => {
  expect(await continuationOverrides(sessionId, { model: null, agent: null, directory: '/w' })).toEqual({
    agent: 'main',
    model: GLM,
    variant: 'high',
    directory: '/w',
  });
});
