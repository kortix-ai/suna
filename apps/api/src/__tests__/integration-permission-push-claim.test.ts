/**
 * One permission push per (session, request id) across every API replica.
 * The dedupe used to be an in-process Map, so on a multi-task deploy the
 * second relay of a request id reached a task that had not seen it and pushed
 * again (release gate PROJ-38, v0.13.52 staging: `notified: true` twice).
 * Two gate instances stand in for two replicas; the claim is the database row.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createPermissionPushGate } from '../notifications/permission-push';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

describe('permission push claim', () => {
  test('a request id pushes once across replicas, and a new id pushes again', async () => {
    const project = await seedProject('permission-push-claim');
    seeded.push(project);
    const sessionId = await seedSession(project, crypto.randomUUID());
    const sent: string[] = [];
    const replica = () =>
      createPermissionPushGate({ notify: async (event) => (sent.push(event.sessionId), { sent: 0, reason: 'no_devices' as const }) });
    const [a, b] = [replica(), replica()];
    const req = { sessionId, projectId: project.project_id, requestId: 'per_1' };

    expect(await a.notify(req)).toBe(true);
    expect(await b.notify(req)).toBe(false);
    expect(await a.notify(req)).toBe(false);
    expect(await b.notify({ ...req, requestId: 'per_2' })).toBe(true);

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).notify({ ...req, requestId: 'per_3' })),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    await Promise.resolve();
    expect(sent).toHaveLength(3);
  });
});
