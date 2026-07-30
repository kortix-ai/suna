import { describe, expect, test } from 'bun:test';

import {
  formatModelString,
  formatPromptModel,
  modelProviderMode,
  parseModelKey,
  resolveCurrentAgentName,
  resolveHiddenAutoModel,
  resolvePromptModel,
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
        default: { kortix: 'glm-5.2' },
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

  test('does not guess a provider for bare model ids', () => {
    expect(parseModelKey('deepseek-v4-flash-free')).toBeUndefined();
  });

  test('formats native OpenCode models correctly for command and prompt calls', () => {
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

  test('sends the concrete current model when no explicit model is selected', () => {
    expect(
      resolvePromptModel(undefined, {
        providerID: 'kortix',
        modelID: 'claude-opus-4.8',
      }),
    ).toEqual({ providerID: 'kortix', modelID: 'claude-opus-4.8' });
  });

  test('never emits stale auto selections', () => {
    expect(
      resolvePromptModel(
        { providerID: 'kortix', modelID: 'auto' },
        { providerID: 'kortix', modelID: 'claude-opus-4.8' },
      ),
    ).toEqual({ providerID: 'kortix', modelID: 'claude-opus-4.8' });
    expect(
      resolvePromptModel(undefined, { providerID: 'kortix', modelID: 'auto' }),
    ).toBeUndefined();
  });

  test('keeps the deprecated Auto resolver ABI while failing stale Auto closed', () => {
    expect(
      resolveHiddenAutoModel(
        { providerID: 'kortix', modelID: 'auto' },
        { enableAutoModel: true, isModelValid: () => true },
      ),
    ).toBeUndefined();
    expect(
      resolveHiddenAutoModel(
        { providerID: 'kortix', modelID: 'glm-5.2' },
        { enableAutoModel: false, isModelValid: () => false },
      ),
    ).toEqual({ providerID: 'kortix', modelID: 'glm-5.2' });
  });

  test('project sessions prefer the server-bound agent over global last-used agent', () => {
    expect(
      resolveCurrentAgentName({
        sessionId: 'session-1',
        boundAgentName: 'default',
        lastAgentName: 'reviewer',
      }),
    ).toBe('default');
  });

  test('explicit per-session agent selection wins over the server-bound seed', () => {
    expect(
      resolveCurrentAgentName({
        sessionId: 'session-1',
        sessionAgentName: 'builder',
        boundAgentName: 'default',
        lastAgentName: 'reviewer',
      }),
    ).toBe('builder');
  });

  test('dashboard composer can still seed from global last-used agent', () => {
    expect(resolveCurrentAgentName({ lastAgentName: 'reviewer' })).toBe('reviewer');
  });

  test('project composer prefers its declared default over a cross-project last-used agent', () => {
    expect(
      resolveCurrentAgentName({
        defaultAgentName: 'kortix',
        lastAgentName: 'reviewer',
      }),
    ).toBe('kortix');
  });

  test('an explicit picker choice can override the project default for the current composer', () => {
    expect(
      resolveCurrentAgentName({
        explicitAgentName: 'reviewer',
        defaultAgentName: 'kortix',
        lastAgentName: 'builder',
      }),
    ).toBe('reviewer');
  });
});
