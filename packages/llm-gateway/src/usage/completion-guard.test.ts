import { describe, expect, test } from 'bun:test';
import { jsonHasContent, sseErrorFrame, sseHasContent } from './completion-guard';

describe('jsonHasContent', () => {
  test('true for a normal message completion', () => {
    expect(jsonHasContent({ choices: [{ message: { content: 'hi' } }] })).toBe(true);
  });

  test('true for a tool-call-only completion (no text content)', () => {
    expect(
      jsonHasContent({
        choices: [
          { message: { content: null, tool_calls: [{ id: 't1', function: { name: 'x' } }] } },
        ],
      }),
    ).toBe(true);
  });

  test('true when reasoning-only content is present', () => {
    expect(jsonHasContent({ choices: [{ message: { reasoning: 'thinking...' } }] })).toBe(true);
  });

  test('false for empty choices array — the observed production bug shape', () => {
    expect(jsonHasContent({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBe(
      false,
    );
  });

  test('false when choices is missing entirely', () => {
    expect(jsonHasContent({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toBe(false);
  });

  test('false for a choice with empty string content and no tool calls', () => {
    expect(jsonHasContent({ choices: [{ message: { content: '' } }] })).toBe(false);
  });

  test('false for non-object input', () => {
    expect(jsonHasContent(null)).toBe(false);
    expect(jsonHasContent('nope')).toBe(false);
    expect(jsonHasContent(undefined)).toBe(false);
  });
});

describe('sseHasContent', () => {
  test('true once a delta chunk carries content', () => {
    const buf =
      'data: {"choices":[{"delta":{}}]}\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
    expect(sseHasContent(buf)).toBe(true);
  });

  test('true for a tool_calls delta', () => {
    const buf = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1"}]}}]}\n\n';
    expect(sseHasContent(buf)).toBe(true);
  });

  test('false for a stream that only ever sent an empty stop event', () => {
    const buf = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    expect(sseHasContent(buf)).toBe(false);
  });

  test('false for an empty buffer', () => {
    expect(sseHasContent('')).toBe(false);
  });

  test('ignores malformed JSON lines instead of throwing', () => {
    expect(sseHasContent('data: {not json\n\n')).toBe(false);
  });
});

describe('sseErrorFrame', () => {
  test('extracts an OpenRouter mid-stream error frame', () => {
    const buf =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"error":{"message":"Upstream idle timeout exceeded","code":502}}\n\n';
    expect(sseErrorFrame(buf)).toEqual({ message: 'Upstream idle timeout exceeded', code: 502 });
  });

  test('extracts an error frame without a code', () => {
    const buf = 'data: {"error":{"message":"boom"}}\n\n';
    expect(sseErrorFrame(buf)).toEqual({ message: 'boom' });
  });

  test('null for a clean stream', () => {
    const buf =
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    expect(sseErrorFrame(buf)).toBeNull();
  });

  test('null for an empty buffer and for malformed lines', () => {
    expect(sseErrorFrame('')).toBeNull();
    expect(sseErrorFrame('data: {not json\n\n')).toBeNull();
  });

  test('ignores a non-object error field', () => {
    expect(sseErrorFrame('data: {"error":"nope"}\n\n')).toBeNull();
  });
});
