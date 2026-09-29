import { describe, expect, test } from 'bun:test';

import { inheritParentOrigin } from '../projects/lib/session-origin';
import { resolveRootSessionInitiator, sessionInitiatorLabel } from '../projects/lib/session-initiator';
import { sessionRowMatchesSearch } from '../projects/lib/session-list';

const USER = '11111111-1111-1111-1111-111111111111';
const root = (source: string | null, extra: Partial<Parameters<typeof resolveRootSessionInitiator>[0]> = {}) =>
  resolveRootSessionInitiator({
    source,
    triggerSlug: null,
    userId: USER,
    requestingPrincipalType: 'human',
    channelSenderIsLinked: false,
    ...extra,
  });

describe('resolveRootSessionInitiator', () => {
  test.each([
    ['ui', { type: 'member', id: USER }],
    ['cli', { type: 'member', id: USER }],
    [null, { type: 'member', id: USER }],
    ['email', { type: 'channel', id: 'email' }],
    ['telegram', { type: 'channel', id: 'telegram' }],
    ['slack', { type: 'channel', id: 'slack' }],
    ['teams', { type: 'channel', id: 'teams' }],
    ['system:sandbox-build-fix', { type: 'system', id: 'system:sandbox-build-fix' }],
  ] as const)('source %p', (source, expected) => {
    expect(root(source)).toEqual(expected);
  });

  test('a trigger run is the trigger’s, named by its slug', () => {
    expect(root('trigger:cron', { triggerSlug: 'nightly' })).toEqual({ type: 'trigger', id: 'nightly' });
    expect(root('trigger:webhook')).toEqual({ type: 'trigger', id: null });
  });

  test('a Slack/Teams message from a linked member is that member’s', () => {
    expect(root('slack', { channelSenderIsLinked: true })).toEqual({ type: 'member', id: USER });
    expect(root('teams', { channelSenderIsLinked: true })).toEqual({ type: 'member', id: USER });
  });

  test('a service-account caller is api; a trigger source still wins', () => {
    expect(root('ui', { requestingPrincipalType: 'service_account' })).toEqual({ type: 'api', id: USER });
    expect(root('trigger:manual', { requestingPrincipalType: 'service_account', triggerSlug: 't' })).toEqual({
      type: 'trigger',
      id: 't',
    });
  });

  test('a non-string source never throws', () => {
    expect(root(42 as unknown as string)).toEqual({ type: 'member', id: USER });
  });
});

describe('inheritParentOrigin', () => {
  test.each([
    ['user', 'trigger', 'trigger'],
    ['user', 'schedule', 'schedule'],
    ['user', 'system', 'system'],
    // backend is NEVER inherited: the in-session token must not gain backend-only overrides.
    ['user', 'backend', 'user'],
    ['user', 'user', 'user'],
    ['user', null, 'user'],
    // An own class that is already not `user` stands.
    ['trigger', 'schedule', 'trigger'],
    ['backend', 'trigger', 'backend'],
  ] as const)('own %p + parent %p = %p', (own, parent, expected) => {
    expect(inheritParentOrigin(own, parent)).toBe(expected);
  });
});

describe('sessionInitiatorLabel', () => {
  test('names each starter', () => {
    expect(sessionInitiatorLabel({ type: 'member', id: USER }, 'Ada')).toBe('Ada');
    expect(sessionInitiatorLabel({ type: 'api', id: 'sa' }, 'ci-bot')).toBe('ci-bot');
    expect(sessionInitiatorLabel({ type: 'trigger', id: 'nightly' }, null)).toBe('nightly');
    expect(sessionInitiatorLabel({ type: 'channel', id: 'slack' }, null)).toBe('Slack');
    expect(sessionInitiatorLabel({ type: 'system', id: 'system:x' }, null)).toBe('Kortix');
  });
});

describe('sessionRowMatchesSearch', () => {
  const row = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ sessionId: 'abcdef12-0000', initiatorId: null, metadata, ...extra }) as never;
  test('matches title, runtime title, initiator and id prefix, case-insensitively', () => {
    expect(sessionRowMatchesSearch(row({ custom_name: 'Rent Research' }), 'rent')).toBe(true);
    expect(sessionRowMatchesSearch(row({ opencode_sessions: [{ title: 'Deploy fix' }] }), 'DEPLOY')).toBe(true);
    expect(sessionRowMatchesSearch(row({}, { initiatorId: 'software-factory' }), 'factory')).toBe(true);
    expect(sessionRowMatchesSearch(row({}), 'ABCDEF')).toBe(true);
    expect(sessionRowMatchesSearch(row({ name: 'Other' }), 'rent')).toBe(false);
  });
});
