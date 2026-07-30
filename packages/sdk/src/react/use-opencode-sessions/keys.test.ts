import { describe, expect, test } from 'bun:test';

import { opencodeKeys } from './keys';

describe('OpenCode runtime query keys', () => {
  test('scopes a repeated OpenCode session id to its sandbox runtime', () => {
    expect(opencodeKeys.runtimeSession('ses_shared', 'sandbox-a')).not.toEqual(
      opencodeKeys.runtimeSession('ses_shared', 'sandbox-b'),
    );
    expect(opencodeKeys.runtimeMessages('ses_shared', 'sandbox-a')).not.toEqual(
      opencodeKeys.runtimeMessages('ses_shared', 'sandbox-b'),
    );
  });

  test('keeps the runtime scope at the end for prefix invalidation compatibility', () => {
    expect(opencodeKeys.runtimeSession('ses_1', 'sandbox-a')).toEqual([
      'opencode',
      'session',
      'ses_1',
      'sandbox-a',
    ]);
    expect(opencodeKeys.runtimeMessages('ses_1', 'sandbox-a')).toEqual([
      'opencode',
      'session',
      'ses_1',
      'messages',
      'sandbox-a',
    ]);
  });

  test('preserves legacy key factories for published consumers', () => {
    expect(opencodeKeys.session('ses_1')).toEqual(['opencode', 'session', 'ses_1']);
    expect(opencodeKeys.messages('ses_1')).toEqual(['opencode', 'session', 'ses_1', 'messages']);
  });
});
