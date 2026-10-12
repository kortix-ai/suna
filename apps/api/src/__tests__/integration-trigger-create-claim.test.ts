/**
 * Integration test (real local PostgreSQL): of N concurrent deliveries for one
 * trigger key, exactly one wins the create; a release lets the next one in; an
 * expired claim (its creator died) is taken over.
 */
import { expect, test } from 'bun:test';
import { chatEventDedup } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { claimTriggerCreate, releaseTriggerCreate, triggerCreateKey } from '../projects/lib/trigger-create-claim';

test('exactly one of eight concurrent deliveries wins the create for a key', async () => {
  const key = `p:${crypto.randomUUID()}:key:chat-1`;
  const results = await Promise.all(Array.from({ length: 8 }, () => claimTriggerCreate(key)));
  expect(results.filter(Boolean)).toHaveLength(1);
  await releaseTriggerCreate(key);
  expect(await claimTriggerCreate(key)).toBe(true);
  await releaseTriggerCreate(key);
});

test('an expired claim is taken over', async () => {
  const key = `p:${crypto.randomUUID()}:key:chat-2`;
  expect(await claimTriggerCreate(key)).toBe(true);
  await db
    .update(chatEventDedup)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(chatEventDedup.eventId, `trigger-create:${key}`));
  expect(await claimTriggerCreate(key)).toBe(true);
  await releaseTriggerCreate(key);
});

test('only keyed and reuse triggers serialize their create', () => {
  const base = { projectId: 'p', slug: 's' };
  expect(triggerCreateKey({ ...base, sessionKey: 'k', sessionMode: 'keyed' })).toBe('p:s:key:k');
  expect(triggerCreateKey({ ...base, sessionKey: null, sessionMode: 'reuse' })).toBe('p:s:reuse');
  expect(triggerCreateKey({ ...base, sessionKey: null, sessionMode: 'new' })).toBeNull();
});
