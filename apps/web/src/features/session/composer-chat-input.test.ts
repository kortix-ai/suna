import { describe, expect, test } from 'bun:test';
import { buildComposerOptions } from './composer-chat-input';

describe('harness-aware composer options', () => {
  test.each(['claude', 'codex', 'pi'])(
    '%s sends the agent without a stale gateway model override',
    (harness) => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
        }),
      ).toEqual({ agent: harness });
    },
  );

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
});
