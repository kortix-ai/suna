import { describe, expect, test } from 'bun:test';
import { isPersonalSession } from '../../drives/service';
import { resolveSessionOrigin } from '../lib/session-origin';
import { GOAL_SESSION_SOURCE } from './effects';

describe('goal sessions are the person\'s own private sessions', () => {
  test('the engine creates them with a source that resolves to origin user', () => {
    expect(resolveSessionOrigin({ source: GOAL_SESSION_SOURCE })).toBe('user');
  });
  test('so Files mounts the creator\'s folder in them (a system origin would mount none)', () => {
    const facts = { createdBy: 'u1', origin: resolveSessionOrigin({ source: GOAL_SESSION_SOURCE }), visibility: 'private', metadata: { unattended: 'true', goal_role: 'owner' } };
    expect(isPersonalSession(facts as never, 'u1')).toBe(true);
    expect(isPersonalSession({ ...facts, origin: resolveSessionOrigin({ source: 'system:goal' }) } as never, 'u1')).toBe(false);
  });
});
