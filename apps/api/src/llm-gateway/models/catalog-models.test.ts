import { describe, expect, test } from 'bun:test';
import { DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS } from '@kortix/shared/llm-catalog';

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

    const managedOnly = gatewayModelCatalog(undefined);
    expect(managedOnly.auto).toBeDefined();
    // anonymous = managed-only; with a project, BYOK + codex widen the catalog
    expect(Object.keys(full).length).toBeGreaterThan(Object.keys(managedOnly).length);
  });

  test('OpenCode Zen free models are managed, not leaked as native opencode catalog entries', () => {
    for (const id of DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS) {
      expect(full[id], id).toBeDefined();
      expect(full[id]?.free, id).toBe(true);
      expect(full[`opencode/${id}`], `opencode/${id}`).toBeUndefined();
    }
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

  test('free tier sees ONLY free managed models (paid managed hidden)', () => {
    // Every free OpenCode-Zen model present...
    for (const id of DEFAULT_OPENCODE_ZEN_FREE_MODEL_IDS) {
      expect(freeFull[id], id).toBeDefined();
      expect(freeFull[id]?.free, id).toBe(true);
    }
    // ...and AUTO stays (it resolves to a free model for free accounts)...
    expect(freeFull.auto).toBeDefined();
    // ...but every paid managed model is gone.
    for (const id of ['claude-opus-4.8', 'claude-sonnet-4.6', 'fusion', 'qwen3.7-max']) {
      expect(freeFull[id], id).toBeUndefined();
    }
  });

  test('free tier still sees BYOK catalog models (own connected keys work)', () => {
    expect(freeFull['anthropic/claude-opus-4-8']).toBeDefined();
  });

  test('anonymous + free-only = free managed lineup with no BYOK', () => {
    const managedFree = gatewayModelCatalog(undefined, { freeManagedOnly: true });
    expect(managedFree.auto).toBeDefined();
    expect(managedFree['fusion']).toBeUndefined();
    expect(managedFree['anthropic/claude-opus-4-8']).toBeUndefined();
  });

  test('free-tier catalog is its own memoized singleton', () => {
    expect(gatewayModelCatalog('proj', { freeManagedOnly: true })).toBe(freeFull);
  });
});
