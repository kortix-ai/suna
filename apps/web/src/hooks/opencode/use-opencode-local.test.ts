import { describe, expect, test } from 'bun:test';

import { modelProviderMode, scopedModelSelectionKey } from './use-opencode-local';

describe('OpenCode local model selection scoping', () => {
  test('scopes persisted model selections by provider mode', () => {
    expect(scopedModelSelectionKey('session-1', 'native')).toBe('native:session-1');
    expect(scopedModelSelectionKey('session-1', 'gateway')).toBe('gateway:session-1');
    expect(scopedModelSelectionKey(undefined, 'native')).toBeUndefined();
  });

  test('detects gateway mode from the Kortix provider', () => {
    expect(
      modelProviderMode({
        all: [{ id: 'kortix', name: 'Kortix', models: {} }],
        connected: ['kortix'],
        default: { kortix: 'auto' },
      } as any),
    ).toBe('gateway');
  });

  test('keeps native mode for v0.9.68 legacy provider-list responses', () => {
    expect(
      modelProviderMode({
        providers: [{ id: 'opencode', name: 'OpenCode', models: {} }],
        default: { opencode: 'deepseek-v4-flash-free' },
      } as any),
    ).toBe('native');
  });
});
