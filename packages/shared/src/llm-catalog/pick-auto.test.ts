import { describe, expect, test } from 'bun:test';
import { AUTO_MODEL_ID, getManagedModel, pickAutoModel } from './index';

const msg = (content: string) => ({ role: 'user', content });

describe('pickAutoModel', () => {
  test('returns null for any non-auto model (pass-through)', () => {
    expect(pickAutoModel('claude-opus-4.8', { messages: [msg('hi')] })).toBeNull();
    expect(pickAutoModel('anthropic/claude-x', {})).toBeNull();
    expect(pickAutoModel('', {})).toBeNull();
  });

  test('accepts both "auto" and "kortix/auto"', () => {
    expect(pickAutoModel('auto', { messages: [msg('hi')] })).not.toBeNull();
    expect(pickAutoModel('kortix/auto', { messages: [msg('hi')] })).not.toBeNull();
  });

  test('auto always resolves to GLM 5.2 for now (regardless of input)', () => {
    expect(pickAutoModel('auto', { messages: [msg('hello there')] })).toBe('glm-5.2');
    expect(
      pickAutoModel('auto', { messages: [msg('x'.repeat(250_000))], tools: [{ name: 'edit' }] }),
    ).toBe('glm-5.2');
  });

  test('the auto target is a real managed model', () => {
    expect(getManagedModel('glm-5.2'), 'glm-5.2 must exist in MANAGED_MODELS').toBeDefined();
  });

  test('AUTO_MODEL_ID is the bare synthetic id', () => {
    expect(AUTO_MODEL_ID).toBe('auto');
  });
});
