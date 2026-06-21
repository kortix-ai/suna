import { describe, test, expect } from 'bun:test';
import {
  openaiToConverse,
  converseToOpenai,
  mapStopReason,
  usageFromConverse,
  makeStreamTranslator,
} from '../services/bedrock-translate';

describe('openaiToConverse — messages', () => {
  test('splits system messages into the system field', () => {
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
      },
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
    );
    expect(req.system).toEqual([{ text: 'be terse' }]);
    expect(req.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
  });

  test('merges consecutive same-role turns (tool result + user)', () => {
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'getWeather', arguments: '{"city":"NYC"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 't1', content: 'sunny' },
        ],
      },
      'model',
    );
    // user → assistant(toolUse) → user(toolResult)
    expect(req.messages).toHaveLength(3);
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((req.messages[1].content[0] as any).toolUse).toMatchObject({
      toolUseId: 't1',
      name: 'getWeather',
      input: { city: 'NYC' },
    });
    expect((req.messages[2].content[0] as any).toolResult).toMatchObject({ toolUseId: 't1' });
  });

  test('merges a tool result followed by a user message into one user turn', () => {
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [
          { role: 'tool', tool_call_id: 't1', content: 'sunny' },
          { role: 'user', content: 'thanks' },
        ],
      },
      'model',
    );
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    expect(req.messages[0].content).toHaveLength(2);
  });

  test('maps tool result back into a user turn', () => {
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [{ role: 'tool', tool_call_id: 'abc', content: 'result text' }],
      },
      'model',
    );
    expect(req.messages[0].role).toBe('user');
    expect((req.messages[0].content[0] as any).toolResult).toMatchObject({
      toolUseId: 'abc',
      content: [{ text: 'result text' }],
    });
  });

  test('decodes base64 data-url images into image blocks', () => {
    // "hi" base64 = aGk=
    const dataUrl = 'data:image/png;base64,aGk=';
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      'model',
    );
    const blocks = req.messages[0].content;
    expect((blocks[0] as any).text).toBe('what is this');
    expect((blocks[1] as any).image.format).toBe('png');
    expect((blocks[1] as any).image.source.bytes).toBeInstanceOf(Uint8Array);
  });
});

describe('openaiToConverse — inference config & tools', () => {
  test('maps max_tokens / temperature / top_p / stop', () => {
    const req = openaiToConverse(
      { model: 'x', messages: [], max_tokens: 100, temperature: 0.5, top_p: 0.9, stop: ['END'] },
      'model',
    );
    expect(req.inferenceConfig).toEqual({
      maxTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  test('translates tools and required tool_choice', () => {
    const req = openaiToConverse(
      {
        model: 'x',
        messages: [],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', description: 'find', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'required',
      },
      'model',
    );
    expect(req.toolConfig?.tools[0].toolSpec.name).toBe('lookup');
    expect(req.toolConfig?.toolChoice).toEqual({ any: {} });
  });

  test('reasoning budget forces temperature=1 and adds thinking field', () => {
    const req = openaiToConverse(
      { model: 'x', messages: [], temperature: 0.2 },
      'model',
      4096,
    );
    expect(req.inferenceConfig?.temperature).toBe(1);
    expect(req.inferenceConfig?.topP).toBeUndefined();
    expect(req.additionalModelRequestFields?.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });
  });
});

describe('converseToOpenai', () => {
  test('builds an OpenAI completion with text + usage', () => {
    const out = converseToOpenai(
      {
        output: { message: { role: 'assistant', content: [{ text: 'hello world' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 3 },
      },
      'bedrock/anthropic/claude-opus-4.8',
      'req123',
    );
    expect(out.object).toBe('chat.completion');
    const choice = (out.choices as any[])[0];
    expect(choice.message.content).toBe('hello world');
    expect(choice.finish_reason).toBe('stop');
    expect((out.usage as any).prompt_tokens).toBe(12);
    expect((out.usage as any).completion_tokens).toBe(7);
    expect((out.usage as any).prompt_tokens_details.cached_tokens).toBe(3);
  });

  test('surfaces tool calls', () => {
    const out = converseToOpenai(
      {
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 'tu1', name: 'search', input: { q: 'x' } } }],
          },
        },
        stopReason: 'tool_use',
      },
      'm',
      'r',
    );
    const choice = (out.choices as any[])[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls[0]).toMatchObject({
      id: 'tu1',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    });
  });
});

describe('mapStopReason / usageFromConverse', () => {
  test('maps known stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('stop');
    expect(mapStopReason('max_tokens')).toBe('length');
    expect(mapStopReason('tool_use')).toBe('tool_calls');
    expect(mapStopReason('guardrail_intervened')).toBe('content_filter');
    expect(mapStopReason(undefined)).toBe('stop');
  });

  test('usageFromConverse normalizes fields', () => {
    expect(usageFromConverse({ inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1 })).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      cachedTokens: 1,
    });
    expect(usageFromConverse(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    });
  });
});

describe('makeStreamTranslator', () => {
  test('emits role chunk, text deltas, tool calls, and usage', () => {
    const t = makeStreamTranslator('m', 'r');
    const out: string[] = [];
    out.push(t.start());
    out.push(...t.event({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hel' } } }));
    out.push(...t.event({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } }));
    out.push(
      ...t.event({
        contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu', name: 'fn' } } },
      }),
    );
    out.push(
      ...t.event({
        contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"a":1}' } } },
      }),
    );
    out.push(...t.event({ messageStop: { stopReason: 'end_turn' } }));
    out.push(
      ...t.event({ metadata: { usage: { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 0 } } }),
    );
    out.push(t.done());

    const joined = out.join('');
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"Hel"');
    expect(joined).toContain('"content":"lo"');
    // tool call start carries name + index
    expect(joined).toContain('"name":"fn"');
    expect(joined).toContain('"arguments":"{\\"a\\":1}"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).toContain('"prompt_tokens":4');
    expect(joined).toContain('"completion_tokens":6');
    expect(joined.trim().endsWith('[DONE]')).toBe(true);
  });

  test('maps multiple tool-use blocks to distinct tool_call indices', () => {
    const t = makeStreamTranslator('m', 'r');
    const a = t.event({
      contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'a', name: 'fa' } } },
    });
    const b = t.event({
      contentBlockStart: { contentBlockIndex: 5, start: { toolUse: { toolUseId: 'b', name: 'fb' } } },
    });
    const da = t.event({ contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: 'x' } } } });
    const db = t.event({ contentBlockDelta: { contentBlockIndex: 5, delta: { toolUse: { input: 'y' } } } });
    expect(a.join('')).toContain('"index":0');
    expect(b.join('')).toContain('"index":1');
    expect(da.join('')).toContain('"index":0');
    expect(db.join('')).toContain('"index":1');
  });
});
