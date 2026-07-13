import { describe, expect, test } from 'bun:test';
import { boundSessionAgentName, buildComposerOptions } from './composer-chat-input';

describe('harness-aware composer options', () => {
  test('locks an existing session to its persisted logical agent', () => {
    expect(boundSessionAgentName('  claude  ')).toBe('claude');
    expect(boundSessionAgentName(null)).toBeNull();
  });

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} sends the agent without a stale gateway model override`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
        }),
      ).toEqual({ agent: harness });
    });
  }

  for (const harness of ['claude', 'codex', 'pi'] as const) {
    test(`${harness} carries an explicit harness-native model without a gateway model key`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'stale/model' },
          runtimeModel: ' native/model ',
        }),
      ).toEqual({
        agent: harness,
        runtimeModel: 'native/model',
        modelSelection: {
          kind: 'custom',
          modelId: 'native/model',
          connectionId: null,
        },
      });
    });
  }

  test('OpenCode retains the selected catalog model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      }),
    ).toEqual({
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      modelSelection: {
        kind: 'custom',
        modelId: 'kortix/openai/gpt-5.4',
        connectionId: null,
      },
    });
  });

  test('OpenCode ignores a stale harness-native model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        runtimeModel: 'native/model',
      }),
    ).toEqual({ agent: 'kortix' });
  });
});
