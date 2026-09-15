import { expect, test } from 'bun:test';
import { parsePromptInput } from './prompt-input';

test.each(['none', 'low', 'high', 'max'])('accepts the declared reasoning variant %s', variant => {
  expect(parsePromptInput(JSON.stringify({ variant, parts: [{ type: 'text', text: 'Hello' }] }), {
    variants: ['none', 'low', 'high', 'max'],
  })).toEqual({ ok: true, value: { text: 'Hello', variant } });
});

test.each([null, false, 42, {}, [], '', 'medium', 'ultra'].map(variant => [variant] as const))(
  'rejects an undeclared reasoning variant %j before admission', variant => {
    expect(parsePromptInput(JSON.stringify({ variant, parts: [{ type: 'text', text: 'Hello' }] }), {
      variants: ['high'],
    }).ok).toBe(false);
  },
);

test('a worker without reasoning metadata rejects a requested variant', () => {
  expect(parsePromptInput(JSON.stringify({ variant: 'high', parts: [{ type: 'text', text: 'Hello' }] }), {}).ok).toBe(false);
});
