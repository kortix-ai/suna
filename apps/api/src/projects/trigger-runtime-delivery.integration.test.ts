/**
 * A prompt delivered after its trigger was deleted must not bring the
 * trigger's runtime row back.
 *
 * 2026-10-29, prod: a session reminder was deleted while its queued prompt
 * waited for its session. The delivery 16 minutes later inserted a runtime row
 * with only status columns (no type, no spec, `schedule_revision` NULL). The
 * catalog reconcile skips dotted slugs, so nothing ever filled or removed it,
 * and the connector sweep read it as "catalog backfill pending" and ran
 * back-to-back on the leader.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { markTriggerRuntimeDelivered, markTriggerRuntimeDeliveryFailed } from './trigger-execution-store';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

const runtimeRows = (slug: string) =>
  db
    .select()
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, PROJECT), eq(projectTriggerRuntime.slug, slug)));

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'trigger-runtime-delivery' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'trigger runtime delivery',
    repoUrl: 'https://example.test/trigger-runtime-delivery.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('a delivery for a deleted trigger writes no runtime row', async () => {
  const when = new Date();
  await markTriggerRuntimeDelivered({ projectId: PROJECT, slug: 'reminder.deleted', when });
  await markTriggerRuntimeDeliveryFailed({ projectId: PROJECT, slug: 'deleted-cron', when, error: 'runtime did not answer' });

  expect(await runtimeRows('reminder.deleted')).toEqual([]);
  expect(await runtimeRows('deleted-cron')).toEqual([]);
});

test('a delivery for a live trigger records its status', async () => {
  await db.insert(projectTriggerRuntime).values({ projectId: PROJECT, slug: 'live', lastStatus: 'queued', updatedAt: new Date(0) });

  const delivered = new Date();
  await markTriggerRuntimeDelivered({ projectId: PROJECT, slug: 'live', when: delivered });
  expect((await runtimeRows('live'))[0]).toMatchObject({ lastStatus: 'fired', lastError: null, lastAttemptAt: delivered });

  const failed = new Date(delivered.getTime() + 1_000);
  await markTriggerRuntimeDeliveryFailed({ projectId: PROJECT, slug: 'live', when: failed, error: 'runtime did not answer' });
  expect((await runtimeRows('live'))[0]).toMatchObject({ lastStatus: 'failed', lastError: 'runtime did not answer', lastAttemptAt: failed });
});
