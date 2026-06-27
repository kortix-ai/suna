import { describe, expect, test } from 'bun:test';

import { gatewayModelCatalog } from './catalog-models';

// The sandbox agent server injects this catalog into OpenCode verbatim and does NO
// client-side limit backfill — so the gateway MUST guarantee a usable context window
// on every served model, or OpenCode can't size conversations and a long session
// pins at 100% context. These tests lock that server-side guarantee.
describe('gatewayModelCatalog — served catalog', () => {
  const full = gatewayModelCatalog('proj');

  test('every served model carries a positive context limit', () => {
    const missing = Object.entries(full)
      .filter(([, m]) => !(typeof m.limit?.context === 'number' && m.limit.context > 0))
      .map(([id]) => id);
    expect(missing).toEqual([]);
  });

  test('AUTO + managed lineup present; anonymous callers get managed-only', () => {
    expect(full.auto).toBeDefined();
    expect(full['claude-opus-4.8']).toBeDefined();
    expect(full['glm-5.2']).toBeDefined();

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeDefined();
    // anonymous = managed-only; with a project, BYOK + codex widen the catalog
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(managedOnly).length);
  });

  test('native OpenCode Zen free models are not served by the gateway catalog', () => {
    for (const id of ['deepseek-v4-flash-free', 'mimo-v2.5-free']) {
      expect(full[`opencode/${id}`], `opencode/${id}`).toBeUndefined();
    }
    expect(full['north-mini-code-free']).toBeUndefined();
    expect(full['nemotron-3-ultra-free']).toBeUndefined();
    expect(full['big-pickle']).toBeUndefined();
    expect(full['opencode/big-pickle']).toBeUndefined();
  });

  test('BYOK catalog entries preserve models.dev metadata for picker visibility', () => {
    const anthropic = full['anthropic/claude-opus-4-8'];
    expect(anthropic).toBeDefined();
    expect(anthropic?.name).toBe('Claude Opus 4.8');
    expect(anthropic?.released).toBeDefined();
    expect(anthropic?.release_date).toBe(anthropic?.released);
  });

  test('catalog is a memoized singleton (built once, not per call)', () => {
    expect(gatewayModelCatalog('proj')).toBe(full);
  });
});

describe('gatewayModelCatalog — free-tier visibility', () => {
  const freeFull = gatewayModelCatalog('proj', { freeManagedOnly: true });

  test('free tier sees no managed Kortix models', () => {
    expect(freeFull.auto).toBeUndefined();
    for (const id of ['claude-opus-4.8', 'claude-sonnet-4.6', 'glm-5.2', 'qwen3.7-max', 'deepseek-v4-flash']) {
      expect(freeFull[id], id).toBeUndefined();
    }
  });

  test('free tier still sees BYOK catalog models (own connected keys work)', () => {
    expect(freeFull['anthropic/claude-opus-4-8']).toBeDefined();
  });

  test('anonymous + free-only = empty catalog', () => {
    const empty = gatewayModelCatalog(undefined, { freeManagedOnly: true });
    expect(empty).toEqual({});
  });

  test('free-tier catalog is its own memoized singleton', () => {
    expect(gatewayModelCatalog('proj', { freeManagedOnly: true })).toBe(freeFull);
  });
});
