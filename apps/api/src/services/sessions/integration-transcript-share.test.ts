import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, projectSessionPublicShares } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for transcript concurrency tests');
process.env.DATABASE_URL = databaseUrl;
const { db } = await import('../../lib/db');
const { createPublicShare, publicShareTokenHash } = await import('./session-public-shares');
const ctx = {
  accountId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
};

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ctx.accountId, name: 'transcript-concurrency' });
  await db.insert(projects).values({
    projectId: ctx.projectId,
    accountId: ctx.accountId,
    name: 'transcript-concurrency',
    repoUrl: 'https://example.test/transcript-concurrency.git',
  });
  await db.insert(projectSessions).values({
    sessionId: ctx.sessionId,
    projectId: ctx.projectId,
    accountId: ctx.accountId,
    branchName: `session/${ctx.sessionId}`,
    createdBy: ctx.userId,
    status: 'provisioning',
  });
});

afterAll(async () => {
  await db
    .delete(projectSessionPublicShares)
    .where(eq(projectSessionPublicShares.sessionId, ctx.sessionId));
  await db.execute(sql`update kortix.project_sessions
    set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
    where session_id = ${ctx.sessionId}`);
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, ctx.sessionId));
  await db.delete(projects).where(eq(projects.projectId, ctx.projectId));
  await db.delete(accounts).where(eq(accounts.accountId, ctx.accountId));
});

test('concurrent transcript mints persist one row and return one shared link', async () => {
  const results = await Promise.all([
    createPublicShare({ transcript: true }, ctx),
    createPublicShare({ transcript: true }, ctx),
  ]);
  const [first, second] = results;
  if (!first?.ok || !second?.ok) throw new Error('Both transcript mints must succeed');
  expect(results.map((result) => result.ok && result.created).sort()).toEqual([false, true]);
  expect(first.share.share_id).toBe(second.share.share_id);
  expect(first.share.public_token).toBe(second.share.public_token);
  const rows = await db
    .select()
    .from(projectSessionPublicShares)
    .where(eq(projectSessionPublicShares.sessionId, ctx.sessionId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    shareId: first.share.share_id,
    tokenHash: publicShareTokenHash(first.share.public_token),
    resourceType: 'transcript',
    createdBy: ctx.userId,
    revokedAt: null,
    expiresAt: null,
  });
  const repeat = await createPublicShare({ transcript: true }, ctx);
  if (!repeat.ok) throw new Error('Repeat transcript mint must succeed');
  expect(repeat.created).toBe(false);
  expect(repeat.share.share_id).toBe(first.share.share_id);
  expect(repeat.share.public_token).toBe(first.share.public_token);
  expect(
    await db
      .select()
      .from(projectSessionPublicShares)
      .where(eq(projectSessionPublicShares.sessionId, ctx.sessionId)),
  ).toHaveLength(1);
});
