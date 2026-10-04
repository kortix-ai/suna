import { describe, expect, test } from 'bun:test';
import { triggerModelOverride } from '../../services/triggers/trigger-runtime';

describe('triggerModelOverride', () => {
  test('a wire ref becomes the prompt override OpenCode expects', () => {
    expect(triggerModelOverride('codex/gpt-5.6-luna')).toEqual({ model: { providerID: 'kortix', modelID: 'codex/gpt-5.6-luna' } });
    expect(triggerModelOverride('kortix/glm-5.2')).toEqual({ model: { providerID: 'kortix', modelID: 'glm-5.2' } });
    expect(triggerModelOverride('glm-5.3-flash')).toEqual({ model: { providerID: 'kortix', modelID: 'glm-5.3-flash' } });
  });
  test('off the gateway a ref is the native provider/model split, and a bare managed id has no provider', () => {
    expect(triggerModelOverride('anthropic/claude-sonnet-4-6', false)).toEqual({ model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' } });
    expect(triggerModelOverride('openrouter/z-ai/glm-4.7', false)).toEqual({ model: { providerID: 'openrouter', modelID: 'z-ai/glm-4.7' } });
    expect(triggerModelOverride('kortix/anthropic/claude-sonnet-4-6', false)).toEqual({ model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' } });
    expect(triggerModelOverride('kortix/glm-5.2', false)).toBeUndefined();
  });
  test('no model = no override (the session default applies)', () => {
    expect(triggerModelOverride(null)).toBeUndefined();
    expect(triggerModelOverride('')).toBeUndefined();
    expect(triggerModelOverride('  ')).toBeUndefined();
  });
});
