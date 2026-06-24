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

  test('light (short, no tools) → cheap Chinese model', () => {
    expect(pickAutoModel('auto', { messages: [msg('hello there')] })).toBe('glm-5.2');
  });

  test('any tool use → balanced Chinese model', () => {
    const routed = pickAutoModel('auto', {
      messages: [msg('fix this')],
      tools: [{ name: 'edit' }],
    });
    expect(routed).toBe('deepseek-v4-pro');
  });

  test('huge context → flagship', () => {
    const big = 'x'.repeat(250_000);
    expect(pickAutoModel('auto', { messages: [msg(big)] })).toBe('claude-opus-4.8');
  });

  test('heavy tool use → flagship', () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}` }));
    expect(pickAutoModel('auto', { messages: [msg('do a lot')], tools })).toBe('claude-opus-4.8');
  });

  test('every tier target is a real managed model', () => {
    for (const id of ['glm-5.2', 'deepseek-v4-pro', 'claude-opus-4.8']) {
      expect(getManagedModel(id), `${id} must exist in MANAGED_MODELS`).toBeDefined();
    }
  });

  test('AUTO_MODEL_ID is the bare synthetic id', () => {
    expect(AUTO_MODEL_ID).toBe('auto');
  });
});
