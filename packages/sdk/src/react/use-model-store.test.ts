import { describe, expect, test } from 'bun:test';

import { getRuntimeModel, setRuntimeModel } from './use-model-store';

describe('runtime model store — per-agent harness-native model', () => {
  test('round-trips a model id keyed by agent name', () => {
    setRuntimeModel('claude-reviewer', 'claude-opus-4-8');
    expect(getRuntimeModel('claude-reviewer')).toBe('claude-opus-4-8');
  });

  test('keys two agents on the same harness independently', () => {
    setRuntimeModel('claude-reviewer', 'claude-opus-4-8');
    setRuntimeModel('claude-builder', 'claude-sonnet-4-6');
    expect(getRuntimeModel('claude-reviewer')).toBe('claude-opus-4-8');
    expect(getRuntimeModel('claude-builder')).toBe('claude-sonnet-4-6');
  });

  test('clearing to undefined drops the entry (falls back to harness default)', () => {
    setRuntimeModel('codex-agent', 'gpt-5.4');
    expect(getRuntimeModel('codex-agent')).toBe('gpt-5.4');
    setRuntimeModel('codex-agent', undefined);
    expect(getRuntimeModel('codex-agent')).toBeUndefined();
  });

  test('an agent with no stored pick reads as undefined (harness default)', () => {
    expect(getRuntimeModel('never-touched-agent')).toBeUndefined();
  });
});
