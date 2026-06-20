import { describe, expect, test } from 'bun:test';
import {
  listProjectWarmTemplates,
  resolveTemplateWarmConfig,
  resolveWarmConfig,
  warmBoxReapReason,
  warmPoolEnabled,
} from '../platform/services/warm-pool';

test('warm pool is AVAILABLE by default (KORTIX_WARM_POOL_ENABLED on), off per template', () => {
  expect(warmPoolEnabled()).toBe(true);
});

describe('resolveTemplateWarmConfig (per-template, opt-in)', () => {
  // The feature is available by default, so `enabled` mirrors the per-template
  // opt-in: true only when that slug was explicitly turned on.
  test('reads per-template config keyed by slug; enabled mirrors the opt-in', () => {
    const meta = {
      warm_pool_templates: { default: { enabled: true, size: 3 }, 'suna-dev': { enabled: false, size: 5 } },
    };
    expect(resolveTemplateWarmConfig(meta, 'default')).toEqual({ enabled: true, size: 3 });
    expect(resolveTemplateWarmConfig(meta, 'suna-dev')).toEqual({ enabled: false, size: 5 });
  });
  test('defaults to disabled + size 1 when a slug is unset (opt-in)', () => {
    expect(resolveTemplateWarmConfig({ warm_pool_templates: {} }, 'default')).toEqual({ enabled: false, size: 1 });
    expect(resolveTemplateWarmConfig(null, 'default')).toEqual({ enabled: false, size: 1 });
    expect(resolveTemplateWarmConfig({}, 'whatever')).toEqual({ enabled: false, size: 1 });
  });
  test('clamps oversized size and rejects non-integer', () => {
    expect(resolveTemplateWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 999 } } }, 'default').size).toBe(25);
    expect(resolveTemplateWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 2.5 } } }, 'default').size).toBe(1);
  });
  test('ignores the legacy project-wide warm_pool opt-out field', () => {
    // The old opt-out config must NOT enable anything under the new opt-in model.
    expect(resolveTemplateWarmConfig({ warm_pool: { enabled: true, size: 4 } }, 'default')).toEqual({ enabled: false, size: 1 });
  });
});

describe('listProjectWarmTemplates', () => {
  test('lists every configured slug with its resolved config', () => {
    const meta = {
      warm_pool_templates: { default: { enabled: true, size: 2 }, custom: { enabled: false, size: 0 } },
    };
    expect(listProjectWarmTemplates(meta)).toEqual([
      { slug: 'default', enabled: true, size: 2 },
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
    expect(resolveWarmConfig({ warm_pool_templates: { default: { enabled: true, size: 3 } } })).toEqual({ enabled: true, size: 3 });
    expect(resolveWarmConfig(null)).toEqual({ enabled: false, size: 1 });
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
