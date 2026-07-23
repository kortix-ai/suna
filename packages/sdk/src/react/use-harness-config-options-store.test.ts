import { describe, expect, test } from 'bun:test';

import type { AcpSessionConfigOption } from '../acp';
import {
  HARNESS_CONFIG_OPTIONS_FALLBACK,
  cacheHarnessConfigOptions,
  getCachedHarnessConfigOptions,
  resolveHarnessConfigOptions,
} from './use-harness-config-options-store';

const CLAUDE_LIVE_OTHER_OPTIONS: AcpSessionConfigOption[] = [
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'auto', name: 'Auto' },
      { value: 'default', name: 'Manual' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    category: 'thought_level',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }],
  },
];

describe('harness config-options cache — pre-session source of the OTHER (non-model) advertised config options', () => {
  test('round-trips a live advertised set, dropping currentValue', () => {
    cacheHarnessConfigOptions('claude', CLAUDE_LIVE_OTHER_OPTIONS);
    const cached = getCachedHarnessConfigOptions('claude');
    expect(cached).toBeDefined();
    expect(cached?.map((o) => o.id)).toEqual(['mode', 'effort']);
    for (const option of cached ?? []) expect(option).not.toHaveProperty('currentValue');
  });

  test('keys two harnesses independently', () => {
    cacheHarnessConfigOptions('claude', CLAUDE_LIVE_OTHER_OPTIONS);
    cacheHarnessConfigOptions('codex', [
      { id: 'fast-mode', type: 'select', options: [{ value: 'off', name: 'Off' }] },
    ]);
    expect(getCachedHarnessConfigOptions('claude')?.length).toBe(2);
    expect(getCachedHarnessConfigOptions('codex')?.length).toBe(1);
  });

  test('resolveHarnessConfigOptions prefers the cache over the static fallback', () => {
    cacheHarnessConfigOptions('claude', [
      { id: 'only-one', type: 'select', options: [{ value: 'x', name: 'X' }] },
    ]);
    const resolved = resolveHarnessConfigOptions('claude');
    expect(resolved.map((o) => o.id)).toEqual(['only-one']);
  });

  test('falls back to [] for a harness this store genuinely knows nothing about', () => {
    expect(getCachedHarnessConfigOptions('pi')).toBeUndefined();
    expect(resolveHarnessConfigOptions('pi')).toEqual([]);
  });

  test('claude and codex always resolve to something real via the static fallback — mode is present for both, and it is never the model option', () => {
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.claude?.some((o) => o.id === 'mode')).toBe(true);
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.codex?.some((o) => o.id === 'mode')).toBe(true);
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.claude?.some((o) => o.id === 'model')).toBe(false);
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.codex?.some((o) => o.id === 'model')).toBe(false);
  });

  test('codex advertises 3 real non-model options: mode, reasoning_effort, fast-mode', () => {
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.codex?.map((o) => o.id)).toEqual([
      'mode',
      'reasoning_effort',
      'fast-mode',
    ]);
  });

  test('opencode has no static fallback — it is not an ownsDefaultModel harness this store speaks for', () => {
    expect(HARNESS_CONFIG_OPTIONS_FALLBACK.opencode).toBeUndefined();
  });
});
