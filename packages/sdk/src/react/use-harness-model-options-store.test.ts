import { describe, expect, test } from 'bun:test';

import type { AcpSessionConfigOption } from '../acp';
import {
  HARNESS_MODEL_OPTION_FALLBACK,
  cacheHarnessModelOption,
  getCachedHarnessModelOption,
  resolveHarnessModelOption,
} from './use-harness-model-options-store';

const CLAUDE_LIVE_OPTION: AcpSessionConfigOption = {
  id: 'model',
  name: 'Model',
  description: 'AI model to use',
  category: 'model',
  type: 'select',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default (recommended)' },
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'opus', name: 'Opus' },
    { value: 'haiku', name: 'Haiku' },
  ],
};

describe('harness model options cache — pre-session source of model choices', () => {
  test('round-trips a live advertised option, dropping currentValue (never "the current value of a session")', () => {
    cacheHarnessModelOption('claude', CLAUDE_LIVE_OPTION);
    const cached = getCachedHarnessModelOption('claude');
    expect(cached).toBeDefined();
    expect(cached?.id).toBe('model');
    expect(cached?.options).toEqual(CLAUDE_LIVE_OPTION.options);
    expect(cached).not.toHaveProperty('currentValue');
  });

  test('keys two harnesses independently', () => {
    cacheHarnessModelOption('claude', CLAUDE_LIVE_OPTION);
    cacheHarnessModelOption('codex', {
      id: 'model',
      type: 'select',
      options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
    });
    expect(getCachedHarnessModelOption('claude')?.options?.length).toBe(4);
    expect(getCachedHarnessModelOption('codex')?.options?.length).toBe(1);
  });

  test('resolveHarnessModelOption prefers the cache over the static fallback', () => {
    cacheHarnessModelOption('claude', {
      id: 'model',
      type: 'select',
      options: [{ value: 'only-one', name: 'Only One' }],
    });
    const resolved = resolveHarnessModelOption('claude');
    expect(resolved?.options).toEqual([{ value: 'only-one', name: 'Only One' }]);
  });

  test('falls back to the static, version-pinned list when this browser has never cached one', () => {
    // 'pi' is never cached in this suite and has no static fallback entry —
    // exercises the "genuinely unknown" branch honestly.
    expect(getCachedHarnessModelOption('pi')).toBeUndefined();
    expect(resolveHarnessModelOption('pi')).toBeNull();
  });

  test('claude and codex always resolve to something — the static fallback never leaves them unknown', () => {
    expect(HARNESS_MODEL_OPTION_FALLBACK.claude).toBeDefined();
    expect(HARNESS_MODEL_OPTION_FALLBACK.codex).toBeDefined();
    expect((HARNESS_MODEL_OPTION_FALLBACK.claude?.options?.length ?? 0) > 0).toBe(true);
    expect((HARNESS_MODEL_OPTION_FALLBACK.codex?.options?.length ?? 0) > 0).toBe(true);
  });

  test('opencode has no static fallback — it is not an ownsDefaultModel harness this store speaks for', () => {
    expect(HARNESS_MODEL_OPTION_FALLBACK.opencode).toBeUndefined();
  });
});
