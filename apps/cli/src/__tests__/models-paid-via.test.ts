import { describe, expect, test } from 'bun:test';
import { paidVia } from '../commands/models.ts';

// `kortix models ls` says how each model is paid for, so a person can tell the
// models their own API keys and ChatGPT subscription reach from Kortix models.
describe('paidVia', () => {
  test('a ChatGPT model, an API-key model, and a Kortix model', () => {
    expect(paidVia('codex/gpt-6-astra', 'codex')).toBe('ChatGPT');
    expect(paidVia('anthropic/claude-opus-4-8', 'anthropic')).toBe('API key');
    expect(paidVia('openrouter/anthropic/claude-3.5', 'openrouter')).toBe('API key');
    expect(paidVia('glm-5.3-flash', 'kortix')).toBe('Kortix');
    expect(paidVia('glm-5.3-flash', undefined)).toBe('Kortix');
  });
});
