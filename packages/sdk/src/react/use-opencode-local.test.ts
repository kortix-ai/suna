import { describe, expect, test } from 'bun:test';

import {
  agentScopedModelSelectionKey,
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

  test('keeps the per-agent model slot keyed by agent name when an agent is loaded', () => {
    expect(agentScopedModelSelectionKey('gateway', 'kortix')).toBe('gateway:kortix');
    expect(agentScopedModelSelectionKey('native', 'kortix')).toBe('native:kortix');
  });

  // A project `member` is deny-by-default on agents, so the composer's agent
  // roster is empty until an explicit resource grant names them. The model pick
  // must still persist: the picker listed every enabled model, but every click
  // was a no-op because the ONLY durable slot was keyed on the (absent) agent
  // and the project-home composer has no sessionId either. Selection must not
  // depend on agent access — the same rule `currentModelKey` already documents
  // on the READ side.
  test('still yields a durable slot when no agent is accessible', () => {
    const key = agentScopedModelSelectionKey('gateway', undefined);
    expect(key).toBe('gateway:');
    expect(key).not.toBe(agentScopedModelSelectionKey('native', undefined));
    // Stable across calls, so a write is readable back by the next render.
    expect(agentScopedModelSelectionKey('gateway', undefined)).toBe(key);
  });

  test('detects gateway mode from the Kortix provider', () => {
    expect(
      modelProviderMode({
        all: [{ id: 'kortix', name: 'Kortix', models: {} }],
        connected: ['kortix'],
        default: { kortix: 'glm-5.3-flash' },
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
        { providerID: 'kortix', modelID: 'glm-5.3-flash' },
        { enableAutoModel: false, isModelValid: () => false },
      ),
    ).toEqual({ providerID: 'kortix', modelID: 'glm-5.3-flash' });
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
