import { describe, expect, test } from 'bun:test';
import { estimateCachedPromptTokens, chunkOutputChars, estimateOutputTokens, estimatePromptTokens, IMAGE_PART_TOKENS } from './estimate';
import { calculateCost } from './pricing';

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

describe('estimateCachedPromptTokens', () => {
  const cacheMarked = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] };

  test('an unmarked request has no cache evidence: 0 cached tokens', () => {
    expect(estimateCachedPromptTokens({ messages: [{ role: 'user', content: 'hi' }] }, 150_000)).toBe(0);
  });

  test('a cache-marked request prices 90% of the prompt as cache reads', () => {
    expect(estimateCachedPromptTokens(cacheMarked, 150_000)).toBe(135_000);
    expect(estimateCachedPromptTokens({ prompt_cache_key: 'k', messages: [] }, 150_000)).toBe(135_000);
  });

  test('Stop on a warm 150k prompt settles at ~$0.1228, not $0.6039 (kimi rates, markup 1.2)', () => {
    const rates = { inputPerMillion: 3.3, outputPerMillion: 16.5, cachedInputPerMillion: 0.33 };
    const warm = calculateCost('m', { promptTokens: 150_000, completionTokens: 500, cachedTokens: estimateCachedPromptTokens(cacheMarked, 150_000) }, 1.2, undefined, rates);
    const allUncached = calculateCost('m', { promptTokens: 150_000, completionTokens: 500, cachedTokens: 0 }, 1.2, undefined, rates);
    // (15,000*3.3 + 135,000*0.33 + 500*16.5) / 1e6 * 1.2
    expect(warm.finalCost).toBeCloseTo(0.12276, 5);
    expect(allUncached.finalCost).toBeCloseTo(0.60390, 5);
  });
});
