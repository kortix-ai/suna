import { describe, expect, test } from 'bun:test';

import { maybeNormalizeOpenAIResponsesInput } from '../router/routes/proxy/helpers';

const service = { name: 'openai' } as any;

function normalize(input: unknown[]) {
  const headers = new Headers();
  const body = maybeNormalizeOpenAIResponsesInput(
    service,
    'POST',
    '/responses',
    JSON.stringify({ model: 'openai/gpt-5.4', input }),
    headers,
  );
  return JSON.parse(String(body));
}

describe('OpenAI Responses input normalization', () => {
  test('preserves typed tool outputs and reasoning losslessly', () => {
    const functionOutput = {
      type: 'function_call_output',
      call_id: 'call_123',
      output: 'ACP_TOOL_OK',
    };
    const reasoning = {
      type: 'reasoning',
      id: 'rs_123',
      encrypted_content: 'opaque-state',
      summary: [],
    };

    expect(normalize([functionOutput, reasoning]).input).toEqual([
      functionOutput,
      reasoning,
    ]);
  });

  test('still converts legacy untyped messages to conservative role content', () => {
    expect(normalize([{ role: 'assistant', content: [{ text: 'legacy' }] }]).input)
      .toEqual([{ role: 'user', content: 'legacy' }]);
  });
});
