import { describe, test, expect } from 'bun:test';
import {
  extractUsageFromJson,
  extractUsageFromSseBuffer,
} from '../llm-gateway/services/usage-extractor';

describe('extractUsageFromJson', () => {
  test('full usage block', () => {
    const json = {
      model: 'anthropic/claude-opus-4.8',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 34,
        cached_tokens: 5,
        cost: 0.000123,
      },
    };
    const u = extractUsageFromJson(json);
    expect(u.promptTokens).toBe(12);
    expect(u.completionTokens).toBe(34);
    expect(u.cachedTokens).toBe(5);
    expect(u.upstreamCostHint).toBe(0.000123);
    expect(u.model).toBe('anthropic/claude-opus-4.8');
  });

  test('falls back to prompt_tokens_details.cached_tokens when top-level missing', () => {
    const u = extractUsageFromJson({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });
    expect(u.cachedTokens).toBe(20);
  });

  test('missing usage block → all zeros', () => {
    const u = extractUsageFromJson({ model: 'x/y' });
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(0);
    expect(u.cachedTokens).toBe(0);
    expect(u.upstreamCostHint).toBeUndefined();
    expect(u.model).toBe('x/y');
  });

  test('completely empty payload is safe', () => {
    const u = extractUsageFromJson({});
    expect(u.promptTokens).toBe(0);
    expect(u.model).toBeUndefined();
  });
});

describe('extractUsageFromSseBuffer', () => {
  test('parses usage from the final SSE chunk', () => {
    const buf = [
      'data: {"model":"openai/gpt-4o-mini","choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'data: {"model":"openai/gpt-4o-mini","choices":[{"delta":{"content":" there"}}]}',
      '',
      'data: {"model":"openai/gpt-4o-mini","usage":{"prompt_tokens":8,"completion_tokens":3,"cost":0.000004}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const u = extractUsageFromSseBuffer(buf);
    expect(u).not.toBeNull();
    expect(u!.promptTokens).toBe(8);
    expect(u!.completionTokens).toBe(3);
    expect(u!.upstreamCostHint).toBe(0.000004);
    expect(u!.model).toBe('openai/gpt-4o-mini');
  });

  test('returns null when no usage chunk appears', () => {
    const buf = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"b"}}]}',
      '',
      'data: [DONE]',
    ].join('\n');
    expect(extractUsageFromSseBuffer(buf)).toBeNull();
  });

  test('uses last usage when multiple appear (defensive)', () => {
    const buf = [
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      '',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}',
      '',
    ].join('\n');
    const u = extractUsageFromSseBuffer(buf)!;
    expect(u.promptTokens).toBe(100);
    expect(u.completionTokens).toBe(50);
  });

  test('inherits model from earlier chunk if usage chunk omits it', () => {
    const buf = [
      'data: {"model":"x/y","choices":[{"delta":{"content":"a"}}]}',
      '',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      '',
    ].join('\n');
    const u = extractUsageFromSseBuffer(buf)!;
    expect(u.model).toBe('x/y');
  });

  test('skips malformed JSON chunks without throwing', () => {
    const buf = [
      'data: not-json',
      '',
      'data: {bad",',
      '',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":5}}',
      '',
    ].join('\n');
    const u = extractUsageFromSseBuffer(buf)!;
    expect(u.promptTokens).toBe(5);
  });

  test('ignores non-data lines', () => {
    const buf = [
      'event: usage',
      'id: 123',
      'data: {"usage":{"prompt_tokens":2,"completion_tokens":4}}',
      '',
    ].join('\n');
    const u = extractUsageFromSseBuffer(buf)!;
    expect(u.completionTokens).toBe(4);
  });
});
