import { describe, expect, test } from 'bun:test';
import { buildComposerOptions } from './composer-chat-input';

describe('harness-aware composer options', () => {
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
      ).toEqual({ agent: harness, runtimeModel: 'native/model' });
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
