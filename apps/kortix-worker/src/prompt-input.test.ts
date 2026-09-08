import { describe, expect, test } from 'bun:test';
import { parsePromptInput } from './prompt-input.ts';
import { mintWireMessageId, wireIdTime } from './wire-message-id.ts';

const runtime = {
  agent: 'kortix',
  model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' },
};

describe('parsePromptInput', () => {
  test('preserves validated output formats and rejects a string format', () => {
    for (const format of [{ type: 'text' }, { type: 'json_schema', schema: { type: 'object' } }] as const) {
      expect(parsePromptInput(JSON.stringify({ format, parts: [{ type: 'text', text: 'answer' }] }), runtime))
        .toEqual({ ok: true, value: { text: 'answer', format } });
    }
    expect(parsePromptInput(JSON.stringify({ format: 'x', parts: [{ type: 'text', text: 'answer' }] }), runtime))
      .toEqual({ ok: false, error: 'format must be an object' });
  });
  test('keeps the wire id and every text part in order', () => {
    const messageID = 'msg_01990f4ca010abcdefghijklmn';
    expect(
      parsePromptInput(
        JSON.stringify({
          messageID,
          parts: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
        }),
        runtime,
      ),
    ).toEqual({
      ok: true,
      value: { messageID, text: 'hello world' },
    });
  });

  test('rejects surrounding messageID whitespace instead of changing the turn identity', () => {
    expect(
      parsePromptInput(
        JSON.stringify({
          messageID: ' msg_01990f4ca010abcdefghijklmn ',
          parts: [{ type: 'text', text: 'ship' }],
        }),
        runtime,
      ),
    ).toEqual({
      ok: false,
      error: 'messageID must not contain surrounding whitespace',
    });
  });

  test('rejects a raw future clock before its assistant id can wrap below its parent', () => {
    const nowMs = 1_756_000_000_000;
    const messageID = 'msg_ffffffffffffAAAAAAAAAAAAAA';
    expect(() =>
      mintWireMessageId({
        nowMs,
        newestKnownTime: wireIdTime(messageID),
        random: () => 0,
      }),
    ).toThrow('wire message id ordering clock is exhausted');

    expect(
      parsePromptInput(
        JSON.stringify({ messageID, parts: [{ type: 'text', text: 'ship' }] }),
        runtime,
        nowMs,
      ),
    ).toEqual({
      ok: false,
      error: 'messageID clock is outside the trusted ordering window',
    });
  });

  test('accepts explicit agent and model only when they match the compiled runtime', () => {
    expect(
      parsePromptInput(
        JSON.stringify({
          agent: 'kortix',
          model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' },
          parts: [{ type: 'text', text: 'ship' }],
        }),
        runtime,
      ).ok,
    ).toBe(true);

    const wrongAgent = parsePromptInput(
      JSON.stringify({ agent: 'other', parts: [{ type: 'text', text: 'ship' }] }),
      runtime,
    );
    expect(wrongAgent).toEqual({
      ok: false,
      error: 'agent "other" is not available in this compiled worker',
    });

    const wrongModel = parsePromptInput(
      JSON.stringify({
        model: { providerID: 'kortix', modelID: 'different' },
        parts: [{ type: 'text', text: 'ship' }],
      }),
      runtime,
    );
    expect(wrongModel).toEqual({
      ok: false,
      error: 'model "kortix/different" is not available in this compiled worker',
    });
  });

  test.each(['file', 'agent', 'subtask'])(
    'rejects unsupported %s parts instead of dropping them',
    (type) => {
      const result = parsePromptInput(
        JSON.stringify({ parts: [{ type, text: 'hidden', url: 'data:text/plain,x' }] }),
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        error: `prompt part type "${type}" is not supported by the Pi worker`,
      });
    },
  );

  test.each(['variant', 'temperature', 'modle'])(
    'rejects unsupported %s instead of acknowledging and ignoring it',
    (field) => {
      const result = parsePromptInput(
        JSON.stringify({
          parts: [{ type: 'text', text: 'ship' }],
          [field]: 'x',
        }),
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        error: `prompt field "${field}" is not supported by the Pi worker`,
      });
    },
  );

  test.each(['ignored', 'synthetic', 'metadata', 'id', 'time'])(
    'rejects semantic text-part field %s instead of executing altered input',
    (field) => {
      expect(
        parsePromptInput(
          JSON.stringify({
            parts: [{ type: 'text', text: 'must preserve meaning', [field]: true }],
          }),
          runtime,
        ),
      ).toEqual({
        ok: false,
        error: `text part field "${field}" is not supported by the Pi worker`,
      });
    },
  );

  test('rejects malformed JSON and malformed text parts', () => {
    expect(parsePromptInput('{', runtime)).toEqual({ ok: false, error: 'invalid json body' });
    expect(parsePromptInput('{}', runtime)).toEqual({
      ok: false,
      error: 'parts must be a non-empty array',
    });
    expect(parsePromptInput('{"parts":[{"type":"text"}]}', runtime)).toEqual({
      ok: false,
      error: 'text parts require a string text field',
    });
  });
});
