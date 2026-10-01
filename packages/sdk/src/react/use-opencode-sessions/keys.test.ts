import { describe, expect, test } from 'bun:test';

import { runtimeKeys } from './keys';

describe('OpenCode runtime query keys', () => {
  test('scopes a repeated OpenCode session id to its sandbox runtime', () => {
    expect(runtimeKeys.runtimeSession('ses_shared', 'sandbox-a')).not.toEqual(
      runtimeKeys.runtimeSession('ses_shared', 'sandbox-b'),
    );
    expect(runtimeKeys.runtimeMessages('ses_shared', 'sandbox-a')).not.toEqual(
      runtimeKeys.runtimeMessages('ses_shared', 'sandbox-b'),
    );
  });

  test('keeps the runtime scope at the end for prefix invalidation compatibility', () => {
    expect(runtimeKeys.runtimeSession('ses_1', 'sandbox-a')).toEqual([
      'opencode',
      'session',
      'ses_1',
      'sandbox-a',
    ]);
    expect(runtimeKeys.runtimeMessages('ses_1', 'sandbox-a')).toEqual([
      'opencode',
      'session',
      'ses_1',
      'messages',
      'sandbox-a',
    ]);
  });

  test('preserves legacy key factories for published consumers', () => {
    expect(runtimeKeys.session('ses_1')).toEqual(['opencode', 'session', 'ses_1']);
    expect(runtimeKeys.messages('ses_1')).toEqual(['opencode', 'session', 'ses_1', 'messages']);
  });
});
