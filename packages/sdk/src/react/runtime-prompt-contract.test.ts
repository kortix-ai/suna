import { describe, expect, test } from 'bun:test';

import { normalizeSessionPromptForRuntime } from './runtime-prompt-contract';

describe('normalizeSessionPromptForRuntime', () => {
  const model = { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-5' };

  test('preserves Pi reasoning while removing stale compiled model, agent, and directory selections', () => {
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
      options: { variant: 'high' },
    });
  });

  test.each([undefined, {}, { variant: '' }])('omits empty Pi prompt options', (options) => {
    expect(normalizeSessionPromptForRuntime({
      runtime: 'pi-worker', parts: [{ type: 'text', text: 'continue' }], options,
    })).toEqual({ parts: [{ type: 'text', text: 'continue' }] });
  });

  test('rejects unsupported file and agent parts before a Pi worker receives them', () => {
    expect(() =>
      normalizeSessionPromptForRuntime({
        runtime: 'pi-worker',
        parts: [{ type: 'file', mime: 'text/plain', url: 'data:text/plain,hello' }],
      }),
    ).toThrow('Pi worker prompts accept text and immutable image attachments only');

    expect(() =>
      normalizeSessionPromptForRuntime({
        runtime: 'pi-worker',
        parts: [{ type: 'agent', name: 'review' }],
      }),
    ).toThrow('Pi worker prompts accept text and immutable image attachments only');
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

test('allows immutable Pi image references while keeping compiled selector defaults', () => {
  const parts = [{ type: 'text' as const, text: 'Describe it.' },
    { type: 'file' as const, mime: 'image/png', url: `kortix-attachment:sha256:${'a'.repeat(64)}`, filename: 'sample.png' }];
  expect(normalizeSessionPromptForRuntime({ runtime: 'pi-worker', parts, options: { agent: 'stale', variant: 'high' } }))
    .toEqual({ parts, options: { variant: 'high' } });
});
