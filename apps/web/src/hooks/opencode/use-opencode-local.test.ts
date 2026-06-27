import { describe, expect, test } from 'bun:test';

import {
  formatModelString,
  formatPromptModel,
  modelProviderMode,
  parseModelKey,
  scopedModelSelectionKey,
} from './use-opencode-local';

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

  test('parses bare OpenCode Zen free model ids as native opencode models', () => {
    expect(parseModelKey('deepseek-v4-flash-free')).toEqual({
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  test('formats native OpenCode Zen models correctly for command and prompt calls', () => {
    const model = { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' };
    expect(formatModelString(model)).toBe('deepseek-v4-flash-free');
    expect(formatPromptModel(model)).toEqual(model);
  });

  test('keeps managed and BYOK model wire formats unchanged', () => {
    const managed = { providerID: 'kortix', modelID: 'claude-opus-4.8' };
    const byok = { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' };
    expect(formatModelString(managed)).toBe('kortix/claude-opus-4.8');
    expect(formatPromptModel(managed)).toEqual(managed);
    expect(formatModelString(byok)).toBe('kortix/anthropic/claude-sonnet-4-6');
    expect(formatPromptModel(byok)).toEqual(byok);
  });
});
