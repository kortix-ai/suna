import { describe, expect, test } from 'bun:test';

import { normalizeSessionPromptForRuntime } from './runtime-prompt-contract';

describe('normalizeSessionPromptForRuntime', () => {
  const model = { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-5' };

  test('removes every mutable runtime override from a Pi prompt', () => {
    expect(
      normalizeSessionPromptForRuntime({
        runtime: 'pi-worker',
        parts: [{ type: 'text', text: 'continue', id: 'prt_1' }],
        options: {
          model,
          agent: 'review',
          variant: 'high',
          directory: '/tmp/stale-workspace',
        },
      }),
    ).toEqual({
      parts: [{ type: 'text', text: 'continue', id: 'prt_1' }],
    });
  });

  test('rejects file and agent parts before a text-only Pi worker receives them', () => {
    expect(() =>
      normalizeSessionPromptForRuntime({
        runtime: 'pi-worker',
        parts: [{ type: 'file', mime: 'text/plain', url: 'data:text/plain,hello' }],
      }),
    ).toThrow('Pi worker prompts accept text parts only');

    expect(() =>
      normalizeSessionPromptForRuntime({
        runtime: 'pi-worker',
        parts: [{ type: 'agent', name: 'review' }],
      }),
    ).toThrow('Pi worker prompts accept text parts only');
  });

  test('preserves the complete OpenCode prompt contract', () => {
    const parts = [
      { type: 'text' as const, text: 'review this' },
      { type: 'file' as const, mime: 'text/plain', url: 'data:text/plain,hello' },
      { type: 'agent' as const, name: 'review' },
    ];
    const options = { model, agent: 'review', variant: 'high', directory: '/workspace' };

    expect(normalizeSessionPromptForRuntime({ runtime: 'opencode', parts, options })).toEqual({
      parts,
      options,
    });
  });
});
