import { describe, expect, test } from 'bun:test';
import {
  listProjectWarmTemplates,
  resolveTemplateWarmConfig,
  resolveWarmConfig,
  warmBoxReapReason,
  warmPoolEnabled,
} from '../platform/services/warm-pool';

test('warm pool is fail-safe OFF by default', () => {
  expect(warmPoolEnabled()).toBe(false);
});

describe('resolveTemplateWarmConfig (per-template, opt-in)', () => {
  // The operator gate is off by default, so per-template opt-ins are preserved
  // for size/config but AND-gated to disabled until the platform setting flips.
  test('reads per-template config keyed by slug; enabled is gated off by default', () => {
    const meta = {
      warm_pool_templates: { default: { enabled: true, size: 3 }, 'suna-dev': { enabled: false, size: 5 } },
    };
    expect(resolveTemplateWarmConfig(meta, 'default')).toEqual({ enabled: false, size: 3 });
    expect(resolveTemplateWarmConfig(meta, 'suna-dev')).toEqual({ enabled: false, size: 5 });
  });
  test('defaults to disabled + global default size when a slug is unset (opt-in)', () => {
    expect(resolveTemplateWarmConfig({ warm_pool_templates: {} }, 'default')).toEqual({ enabled: false, size: 0 });
    expect(resolveTemplateWarmConfig(null, 'default')).toEqual({ enabled: false, size: 0 });
    expect(resolveTemplateWarmConfig({}, 'whatever')).toEqual({ enabled: false, size: 0 });
  });
  test('clamps oversized size and rejects non-integer', () => {
    expect(resolveTemplateWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 999 } } }, 'default').size).toBe(25);
    expect(resolveTemplateWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 2.5 } } }, 'default').size).toBe(0);
  });
  test('ignores the legacy project-wide warm_pool opt-out field', () => {
    // The old opt-out config must NOT enable anything under the new opt-in model.
    expect(resolveTemplateWarmConfig({ warm_pool: { enabled: true, size: 4 } }, 'default')).toEqual({ enabled: false, size: 0 });
  });
});

describe('listProjectWarmTemplates', () => {
  test('lists every configured slug with its resolved config', () => {
    const meta = {
      warm_pool_templates: { default: { enabled: true, size: 2 }, custom: { enabled: false, size: 0 } },
    };
    expect(listProjectWarmTemplates(meta)).toEqual([
      { slug: 'default', enabled: false, size: 2 },
      { slug: 'custom', enabled: false, size: 0 },
    ]);
  });
  test('empty when unset', () => {
    expect(listProjectWarmTemplates(null)).toEqual([]);
    expect(listProjectWarmTemplates({})).toEqual([]);
  });
});

describe('resolveWarmConfig (back-compat = default-template config)', () => {
  test('delegates to the default slug', () => {
    expect(resolveWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 3 } } })).toEqual({ enabled: false, size: 3 });
    expect(resolveWarmConfig(null)).toEqual({ enabled: false, size: 0 });
  });
});

describe('warmBoxReapReason', () => {
  const base = { status: 'active', createdAt: new Date(1000), updatedAt: new Date(1000) };
  const now = 1000;

  test('keeps a fresh parked box', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'parked' }, now)).toBeNull();
  });
  test('reaps explicitly marked boxes', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'reap' }, now)).toBe('marked');
  });
  test('reaps errored boxes', () => {
    expect(warmBoxReapReason({ ...base, poolState: 'booting', status: 'error' }, now)).toBe('errored');
  });
  test('reaps a box stuck booting past the timeout', () => {
    const created = new Date(0);
    expect(warmBoxReapReason({ ...base, poolState: 'booting', createdAt: created }, 10 * 60_000, { bootTimeoutMs: 60_000 })).toBe('boot-timeout');
    expect(warmBoxReapReason({ ...base, poolState: 'booting', createdAt: created }, 30_000, { bootTimeoutMs: 60_000 })).toBeNull();
  });
  test('ages out a long-parked box (snapshot drift cycling)', () => {
    const created = new Date(0);
    expect(warmBoxReapReason({ ...base, poolState: 'parked', createdAt: created }, 10 * 60_000, { maxAgeMs: 60_000 })).toBe('aged-out');
  });
});
