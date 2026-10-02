import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { sessionNeedsInputCount } from './use-sessions-needing-input';

describe('sessionNeedsInputCount', () => {
  const summary = { total: 3, sessions: { 'kx-1': 2, 'oc-2': 1 } };

  test('reads the count by session id', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-1' })).toBe(2);
  });

  test('falls back to the runtime session id', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-9', runtime_session_id: 'oc-2' })).toBe(1);
  });

  test('is 0 for a session nothing waits on, and for no summary', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-9' })).toBe(0);
    expect(sessionNeedsInputCount(undefined, { session_id: 'kx-1' })).toBe(0);
  });
});

describe('qk.project.needsInput', () => {
  test('nests under the project scope so a project invalidation reaches it', () => {
    const scope = qk.project.scope('P1');
    expect(qk.project.needsInput('P1').slice(0, scope.length)).toEqual([...scope]);
  });
});
