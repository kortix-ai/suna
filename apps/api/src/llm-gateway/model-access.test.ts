import { describe, expect, test } from 'bun:test';
import { modelAccessAllows, modelAccessProvider, readModelAccess, updateModelAccess } from './model-access';

describe('project model access', () => {
  test('existing projects allow all models regardless of display defaults', () => {
    expect(readModelAccess(null)).toEqual({ disabledProviders: [], disabledModels: [] });
    expect(modelAccessAllows(readModelAccess({ modelOverrides: { old: false } }), 'old')).toBe(true);
  });
  test('Kortix runtime namespace does not swallow BYOK identity', () => {
    expect(modelAccessProvider('kortix/glm-5.3-flash')).toBe('kortix');
    expect(modelAccessProvider('kortix/openrouter/vendor/model')).toBe('openrouter');
    expect(modelAccessProvider('codex/gpt-test')).toBe('codex');
  });
  test('disabled provider covers present and future models but not other providers', () => {
    const p = updateModelAccess(readModelAccess(null), { target: 'provider', id: 'openai', enabled: false });
    expect(modelAccessAllows(p, 'openai/new-model')).toBe(false);
    expect(modelAccessAllows(p, 'kortix/openai/old-model')).toBe(false);
    expect(modelAccessAllows(p, 'anthropic/new-model')).toBe(true);
  });
  test('managed disable leaves BYOK providers available', () => {
    const p = { disabledProviders: ['kortix'], disabledModels: [] };
    expect(modelAccessAllows(p, 'glm-5.3-flash')).toBe(false);
    expect(modelAccessAllows(p, 'kortix/glm-5.3-flash')).toBe(false);
    expect(modelAccessAllows(p, 'openrouter/z-ai/glm-5.3-flash')).toBe(true);
  });
  test('model enable does not override provider disable', () => {
    const p = updateModelAccess({ disabledProviders: ['custom'], disabledModels: ['custom/model'] },
      { target: 'model', id: 'custom/model', enabled: true });
    expect(modelAccessAllows(p, 'custom/model')).toBe(false);
  });
  test('writes are idempotent and do not mutate the input', () => {
    const original = { disabledProviders: [], disabledModels: ['openai/one'] };
    const p = updateModelAccess(original, { target: 'model', id: 'kortix/openai/one', enabled: false });
    expect(p).toEqual(original);
    expect(p).not.toBe(original);
  });
});
