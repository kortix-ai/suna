import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { FlatModel } from './model-flatten';
import { hasUsableModel, useModelStore, type ModelKey } from './use-model-store';

// Regression coverage for connection-gating (`hasUsableModel`/`isVisible`)
// preferring the explicit `provider` field the gateway now serves per model
// over parsing it out of the wire model id — see `subProviderOf` in
// use-model-store.ts. Every model under the gateway is registered under
// `providerID: 'kortix'`; `provider` is the field that says who REALLY
// serves it.
function gatewayModel(partial: Partial<FlatModel> & Pick<FlatModel, 'modelID'>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelName: partial.modelID,
    ...partial,
  };
}

describe('hasUsableModel — gateway connection gating prefers the explicit `provider` field', () => {
  test('a BYOK model is usable when its explicit `provider` is connected, even with an ambiguous modelID', () => {
    // Two embedded slashes — a naive `indexOf('/')` split still happens to
    // work here, but the explicit field is what should actually be read.
    const models = [gatewayModel({ modelID: 'mixlayer/qwen/qwen3.5-9b', provider: 'mixlayer' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['mixlayer']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['qwen']) })).toBe(false);
  });

  test('falls back to string-splitting modelID when `provider` is absent (stale/older catalog)', () => {
    const models = [gatewayModel({ modelID: 'anthropic/claude-opus-4-8' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set() })).toBe(false);
  });

  test('the explicit `provider` field wins even when it disagrees with a naive modelID split', () => {
    // A models.dev provider alias/namespace prefix ("anthropic-legacy") that
    // does not match the real connect-form provider id ("anthropic") — this
    // is exactly the class of drift string-splitting can never handle but an
    // explicit field sidesteps entirely.
    const models = [gatewayModel({ modelID: 'anthropic-legacy/claude-2', provider: 'anthropic' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic']) })).toBe(true);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['anthropic-legacy']) })).toBe(false);
  });

  test('a codex/<id> model gates on the codex subscription, not the raw openai BYOK key', () => {
    const models = [gatewayModel({ modelID: 'codex/gpt-5.6-sol', provider: 'codex' })];
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['openai']) })).toBe(false);
    expect(hasUsableModel(models, { connectedProviderIds: new Set(['codex']) })).toBe(true);
  });

  test('a managed model is usable iff the caller is not free-tier, regardless of `provider`', () => {
    const models = [gatewayModel({ modelID: 'claude-opus-4.8', provider: 'kortix' })];
    expect(hasUsableModel(models, { freeTier: true })).toBe(false);
    expect(hasUsableModel(models, { freeTier: false })).toBe(true);
  });
});

// ============================================================================
// `isVisible` must not depend on which `allModels` array a given surface
// happens to pass — see the `catalogModels` option on `useModelStore`.
// ============================================================================

/**
 * Renders `useModelStore(allModels, opts)` inside a throwaway component via
 * `renderToStaticMarkup` (same no-DOM-needed pattern used by
 * action-panel/mode-gate.test.tsx) and returns the hook's result. Every hook
 * `useModelStore` calls (`useSyncExternalStore`, `useMemo`, `useCallback`)
 * resolves fully synchronously during this render, so the captured value is
 * safe to read and call after `renderToStaticMarkup` returns.
 */
function captureModelStore(
  allModels: FlatModel[],
  opts?: Parameters<typeof useModelStore>[1],
): ReturnType<typeof useModelStore> {
  let captured: ReturnType<typeof useModelStore> | undefined;
  function Harness() {
    captured = useModelStore(allModels, opts);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!captured) throw new Error('useModelStore did not produce a result');
  return captured;
}

function codexModel(partial: Partial<FlatModel> & Pick<FlatModel, 'modelID'>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelName: partial.modelID,
    provider: 'codex',
    ...partial,
  };
}

const monthsAgo = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
};

describe('useModelStore — `isVisible` is independent of the calling surface (catalogModels)', () => {
  // Mirrors the real-world shape that triggers the bug: a `codex/*` family
  // where some models have a live models.dev `releaseDate` and some (e.g.
  // gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna, which have no models.dev
  // entry) do not.
  //
  // `gpt-5.6-max` (1 month ago) is the true newest-in-family; `gpt-5.6-nova`
  // (5 months ago) is recent but NOT the newest. Both carry `family:
  // 'gpt-5.6'` here, matching what the gateway actually serves (and what the
  // full-catalog flattener passes through) — the "connected providers only"
  // flattener some surfaces used (models-tab.tsx before the fix) drops the
  // `family` field entirely, which is exactly what breaks the invariant
  // below.
  const FULL_CATALOG: FlatModel[] = [
    codexModel({ modelID: 'codex/gpt-5.6-max', family: 'gpt-5.6', releaseDate: monthsAgo(1) }),
    codexModel({ modelID: 'codex/gpt-5.6-nova', family: 'gpt-5.6', releaseDate: monthsAgo(5) }),
    codexModel({ modelID: 'codex/gpt-5.6-sol', family: 'gpt-5.6' }),
    codexModel({ modelID: 'codex/gpt-5.6-terra', family: 'gpt-5.6' }),
    codexModel({ modelID: 'codex/gpt-5.6-luna', family: 'gpt-5.6' }),
  ];

  // Same 5 models, same releaseDates — but WITHOUT `family` set, reproducing
  // the narrower/differently-shaped array a connected-providers-only surface
  // (e.g. Settings > Models) builds by hand instead of reusing the shared
  // flattener.
  const CONNECTED_ONLY: FlatModel[] = FULL_CATALOG.map((m) => ({ ...m, family: undefined }));

  const KEYS: ModelKey[] = FULL_CATALOG.map((m) => ({ providerID: m.providerID, modelID: m.modelID }));

  const opts = { connectedProviderIds: new Set(['codex']) };

  test('sanity: the two fixtures disagree on visibility without `catalogModels` (proves the fixture reproduces the bug)', () => {
    const full = captureModelStore(FULL_CATALOG, opts);
    const connectedOnly = captureModelStore(CONNECTED_ONLY, opts);

    // Full, family-grouped catalog: only the true newest-in-family
    // (gpt-5.6-max) is "latest"; gpt-5.6-nova has a valid-but-not-newest
    // date so it's explicitly hidden, not merely defaulted.
    expect(full.isVisible({ providerID: 'kortix', modelID: 'codex/gpt-5.6-max' })).toBe(true);
    expect(full.isVisible({ providerID: 'kortix', modelID: 'codex/gpt-5.6-nova' })).toBe(false);

    // Without `family`, every model is its own singleton family, so both
    // dated models independently qualify as "latest" — gpt-5.6-nova comes
    // back visible even though the full-catalog computation says it
    // shouldn't be. This is the surface-dependence bug.
    expect(connectedOnly.isVisible({ providerID: 'kortix', modelID: 'codex/gpt-5.6-max' })).toBe(true);
    expect(connectedOnly.isVisible({ providerID: 'kortix', modelID: 'codex/gpt-5.6-nova' })).toBe(true);
  });

  test('fix: passing the same `catalogModels` makes both surfaces agree on every key', () => {
    // Simulates model-selector.tsx: allModels IS the full catalog, so
    // `catalogModels` defaults to it.
    const fullCatalogSurface = captureModelStore(FULL_CATALOG, opts);

    // Simulates models-tab.tsx post-fix: allModels stays the narrow,
    // connected-only, family-less array (what's actually rendered), but
    // `catalogModels` is explicitly the same full catalog every other
    // surface uses to resolve defaults.
    const connectedOnlySurface = captureModelStore(CONNECTED_ONLY, {
      ...opts,
      catalogModels: FULL_CATALOG,
    });

    for (const key of KEYS) {
      expect(connectedOnlySurface.isVisible(key)).toBe(fullCatalogSurface.isVisible(key));
    }

    // Pin the actual values too, not just their equality, so a future change
    // that makes both sides equally wrong still fails this test.
    const expected: Record<string, boolean> = {
      'codex/gpt-5.6-max': true,
      'codex/gpt-5.6-nova': false,
      'codex/gpt-5.6-sol': false,
      'codex/gpt-5.6-terra': false,
      'codex/gpt-5.6-luna': false,
    };
    for (const key of KEYS) {
      expect(connectedOnlySurface.isVisible(key)).toBe(expected[key.modelID]);
    }
  });
});
