import { expect, test } from 'bun:test';
import { createWarmSessionPool, type WarmSessionPoolClient } from './warm-session-pool';

/**
 * Warm sessions were removed on 2026-11-03: the API answers 410 to
 * `POST /projects/:id/sessions/warm` and `/warm/claim`. `createWarmSessionPool`
 * stays exported for semver, as a pool that never holds a session, so a host
 * that still calls it always takes its ordinary create path and sends no
 * request.
 */

interface HeldSession {
  sessionId: string;
}

function recordingClient() {
  const calls: string[] = [];
  const client: WarmSessionPoolClient<HeldSession, { session_id: string }> = {
    ensure: async (projectId) => {
      calls.push(`ensure:${projectId}`);
      return { sessionId: 'never' };
    },
    claim: async (projectId) => {
      calls.push(`claim:${projectId}`);
    },
    read: async (projectId, sessionId) => {
      calls.push(`read:${projectId}:${sessionId}`);
      return { metadata: { warm: true } };
    },
  };
  return { client, calls };
}

test('the pool never holds a session and never calls its client', async () => {
  const { client, calls } = recordingClient();
  const pool = createWarmSessionPool<HeldSession, unknown, { session_id: string }>(client, {
    fits: () => true,
  });

  await pool.ensure('p1');
  await pool.ensure('p1', { excludeSessionId: 's1' });
  await pool.settled();

  expect(pool.held('p1')).toBeNull();
  expect(pool.take('p1', {}, { replenish: true })).toBeNull();
  expect(await pool.prime('p1', { sessionId: 's1' }, { session_id: 's1' })).toBe(false);
  expect(await pool.revalidate('p1')).toBe(false);
  expect(pool.dropBySessionId('s1')).toBeNull();
  pool.reset();
  await pool.settled();
  expect(calls).toEqual([]);
});
