import { expect, test } from 'bun:test';
import { parsePromptInput } from './prompt-input.ts';

test.each([true, false])('preserves the noReply boolean %j', (noReply) => {
  expect(
    parsePromptInput(JSON.stringify({ noReply, parts: [{ type: 'text', text: 'Context.' }] }), {}),
  ).toEqual({ ok: true, value: { text: 'Context.', noReply } });
});

test.each([null, 'true', 1, {}, []].map((noReply) => [noReply] as const))(
  'rejects a non-boolean noReply %j',
  (noReply) => {
    expect(
      parsePromptInput(
        JSON.stringify({
          noReply,
          parts: [{ type: 'text', text: 'Context.' }],
        }),
        {},
      ),
    ).toEqual({ ok: false, error: 'noReply must be a boolean' });
  },
);
