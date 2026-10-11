/**
 * Integration test (real local DB): a webhook delivery runs once, and only
 * once per event (KRTX-1735). A body-hash key used to dedupe forever, and a
 * key whose first command failed (out of credits) or whose session was
 * deleted answered every redelivery with the old failure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { WEBHOOK_REPLAY_WINDOW_MS, releaseWebhookDeliveryKey } from '../projects/lib/webhook-delivery';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const LIVE_SESSION = crypto.randomUUID();
const DELETED_SESSION = crypto.randomUUID();
const OWNER = crypto.randomUUID();

/** A create command that owns `key`, in `status`, made `ageMs` ago. */
async function command(key: string, status: string, opts: { sessionId?: string; ageMs?: number } = {}) {
  const [row] = (await db.execute(sql`
    INSERT INTO kortix.session_lifecycle_commands
      (command_type, source, status, project_id, session_id, account_id, actor_user_id, idempotency_key, payload, created_at)
    VALUES ('create_session', 'trigger:webhook', ${status}::kortix.session_lifecycle_command_status, ${PROJECT}::uuid,
            ${opts.sessionId ?? null}::uuid, ${ACCOUNT}::uuid, ${OWNER}::uuid, ${key}, '{}'::jsonb,
            now() - (${opts.ageMs ?? 0} * interval '1 millisecond'))
    RETURNING command_id`)) as unknown as Array<{ command_id: string }>;
  return row!.command_id;
}

async function keyOf(commandId: string): Promise<string> {
  const [row] = (await db.execute(
    sql`SELECT idempotency_key FROM kortix.session_lifecycle_commands WHERE command_id = ${commandId}::uuid`,
  )) as unknown as Array<{ idempotency_key: string }>;
  return row!.idempotency_key;
}

const key = (name: string) => `trigger:webhook:${PROJECT}:hook:${name}-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'webhook-key-acct' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'webhook-key', repoUrl: 'https://example.test/hook.git' });
  await db.insert(projectSessions).values([
    { sessionId: LIVE_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: 'live', createdBy: OWNER },
    {
      sessionId: DELETED_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: 'deleted',
      createdBy: OWNER,
      metadata: { deletedAt: new Date().toISOString() },
    },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE project_id = ${PROJECT}::uuid`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('releaseWebhookDeliveryKey', () => {
  test('a run that went through keeps its key: the same event is a duplicate', async () => {
    const k = key('ran');
    const id = await command(k, 'succeeded', { sessionId: LIVE_SESSION, ageMs: 60 * 60_000 });
    expect(await releaseWebhookDeliveryKey(k, { byEvent: true })).toBe(0);
    expect(await keyOf(id)).toBe(k);
  });

  test('a dead-lettered first attempt (out of credits) frees the key, so the redelivery runs', async () => {
    const k = key('dead');
    const id = await command(k, 'dead_lettered');
    expect(await releaseWebhookDeliveryKey(k, { byEvent: true })).toBe(1);
    expect(await keyOf(id)).toBe(`${k}:released:${id}`);
  });

  test("a run whose session was deleted frees the key, so the redelivery starts a new session", async () => {
    const k = key('deleted');
    const id = await command(k, 'succeeded', { sessionId: DELETED_SESSION });
    expect(await releaseWebhookDeliveryKey(k, { byEvent: true })).toBe(1);
    expect(await keyOf(id)).toBe(`${k}:released:${id}`);
  });

  test('a body-hash key is a duplicate inside the replay window and a new delivery after it', async () => {
    const recent = key('hash-recent');
    const recentId = await command(recent, 'succeeded', { sessionId: LIVE_SESSION, ageMs: WEBHOOK_REPLAY_WINDOW_MS - 60_000 });
    expect(await releaseWebhookDeliveryKey(recent, { byEvent: false })).toBe(0);
    expect(await keyOf(recentId)).toBe(recent);

    const old = key('hash-old');
    const oldId = await command(old, 'succeeded', { sessionId: LIVE_SESSION, ageMs: WEBHOOK_REPLAY_WINDOW_MS + 60_000 });
    expect(await releaseWebhookDeliveryKey(old, { byEvent: false })).toBe(1);
    expect(await keyOf(oldId)).toBe(`${old}:released:${oldId}`);
  });

  test('an event id never ages out: the same GitHub delivery a day later is still a duplicate', async () => {
    const k = key('event-old');
    const id = await command(k, 'succeeded', { sessionId: LIVE_SESSION, ageMs: 24 * 60 * 60_000 });
    expect(await releaseWebhookDeliveryKey(k, { byEvent: true })).toBe(0);
    expect(await keyOf(id)).toBe(k);
  });

  test('a delivery still queued or running keeps its key', async () => {
    for (const status of ['queued', 'running']) {
      const k = key(status);
      const id = await command(k, status);
      expect(await releaseWebhookDeliveryKey(k, { byEvent: true })).toBe(0);
      expect(await keyOf(id)).toBe(k);
    }
  });
});
