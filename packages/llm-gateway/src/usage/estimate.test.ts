import { describe, expect, test } from 'bun:test';
import { chunkOutputChars, estimateOutputTokens, estimatePromptTokens, IMAGE_PART_TOKENS } from './estimate';

describe('estimatePromptTokens', () => {
  test('counts message text at about four characters per token', () => {
    const tokens = estimatePromptTokens({
      model: 'm',
      messages: [
        { role: 'system', content: 'a'.repeat(400) },
        { role: 'user', content: 'b'.repeat(4_000) },
      ],
    });
    expect(tokens).toBeGreaterThanOrEqual(1_100);
    expect(tokens).toBeLessThan(1_150);
  });

  test('an inline image counts a fixed amount, never its base64 length', () => {
    const image = `data:image/png;base64,${'A'.repeat(4_000_000)}`;
    const tokens = estimatePromptTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    });
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
    expect(tokens).toBeLessThan(IMAGE_PART_TOKENS + 20);
  });

  test('tool definitions count as prompt; the model name does not', () => {
    const withTools = estimatePromptTokens({
      model: 'x'.repeat(1_000),
      messages: [],
      tools: [{ type: 'function', function: { name: 'search', description: 'd'.repeat(800) } }],
    });
    expect(withTools).toBeGreaterThanOrEqual(200);
    expect(withTools).toBeLessThan(230);
  });
});

describe('streamed output', () => {
  test('counts content, reasoning, and tool-call arguments', () => {
    expect(
      chunkOutputChars({
        choices: [
          {
            delta: {
              content: 'hello',
              reasoning: 'why',
              tool_calls: [{ function: { name: 'go', arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
    ).toBe(5 + 3 + 2 + 7);
    expect(chunkOutputChars({ choices: [], usage: { prompt_tokens: 1 } })).toBe(0);
    expect(estimateOutputTokens(9)).toBe(3);
    expect(estimateOutputTokens(0)).toBe(0);
  });
});
