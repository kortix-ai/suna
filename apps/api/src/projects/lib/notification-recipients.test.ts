// The origin class of a session (KRTX-1742 design §3.1): pure, from the
// session row's metadata and origin. The prompter lookups and the share diff
// run against PostgreSQL in __tests__/integration-notification-recipients.test.ts
// and __tests__/integration-notification-share.test.ts.
import { describe, expect, test } from 'bun:test';
import { classifySession } from './notification-recipients';

describe('classifySession', () => {
  test('a session a person runs from Kortix is attended', () => {
    expect(classifySession({ source: 'ui' }, 'user')).toEqual({
      originClass: 'attended',
      isChild: false,
      triggerSlug: null,
    });
    expect(classifySession({}, 'backend').originClass).toBe('attended');
    expect(classifySession(null, null).originClass).toBe('attended');
  });

  test('a system-origin session a person started (sandbox build fix) is attended', () => {
    expect(classifySession({ source: 'system:sandbox-build-fix' }, 'system').originClass).toBe('attended');
  });

  test('each chat channel, by source or by its metadata block', () => {
    for (const channel of ['slack', 'teams', 'email', 'telegram'] as const) {
      expect(classifySession({ source: channel }, 'user').originClass).toBe('channel');
      expect(classifySession({ [channel]: { thread: 'x' } }, 'user').originClass).toBe('channel');
    }
  });

  test('a null channel block is not a channel', () => {
    expect(classifySession({ slack: null, email: null }, 'user').originClass).toBe('attended');
  });

  test('a trigger session is unattended, by its trigger slug or by origin', () => {
    expect(classifySession({ trigger_kind: 'git', trigger_slug: 'nightly', source: 'trigger:cron' }, 'schedule')).toEqual({
      originClass: 'unattended',
      isChild: false,
      triggerSlug: 'nightly',
    });
    expect(classifySession({ trigger_kind: 'git', trigger_slug: 'triage' }, 'user')).toMatchObject({
      originClass: 'unattended',
      triggerSlug: 'triage',
    });
    expect(classifySession({}, 'trigger')).toMatchObject({ originClass: 'unattended', triggerSlug: null });
    expect(classifySession({}, 'schedule').originClass).toBe('unattended');
  });

  test('a coordinator-spawned worker is a child', () => {
    expect(classifySession({ spawned_by_session: 'parent-1', source: 'agent' }, 'user')).toMatchObject({
      originClass: 'attended',
      isChild: true,
    });
  });
});
