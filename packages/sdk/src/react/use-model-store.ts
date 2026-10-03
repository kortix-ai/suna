'use client';

/**
 * React port of the SolidJS `context/models.tsx` from the OpenCode reference app.
 *
 * Provides:
 * - Model visibility (show/hide per model, persisted in localStorage)
 * - Recent models (up to 5, persisted)
 * - "Latest" logic (models released within 6 months, newest per family shown by default)
 * - Variant persistence per model
 *
 * Uses localStorage instead of Solid's persisted store, with a React-compatible
 * zustand-like pattern via useState + useCallback.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ModelKey } from '../core/models/model-key';
import { computeLatestSet, createModelVisibility } from '../core/models/model-visibility';
import { safeSetItem } from '../platform/storage/managed-storage';
import { registerIdentityReset } from './identity-reset-registry';
import type { FlatModel } from './model-flatten';
import { shouldSetSessionAgentName } from './session-agent-name-guard';

// ============================================================================
// Types
// ============================================================================

export { modelKeyToWire, wireToModelKey, type ModelKey } from '../core/models/model-key';

type Visibility = 'show' | 'hide';

interface UserEntry extends ModelKey {
  visibility: Visibility;
  favorite?: boolean;
}

interface ModelStore {
  user: UserEntry[];
  recent: ModelKey[];
  variant: Record<string, string | undefined>;
  /** Persisted per-agent model selection so it survives refresh/new tabs */
  selectedModel?: Record<string, ModelKey | undefined>;
  /** Per-session agent name — keyed by sessionId so each session remembers its own agent */
  sessionAgentName?: Record<string, string | undefined>;
  /**
   * Globally last-used agent name. Persisted so the dashboard (no sessionId) and
   * freshly-created sessions inherit the agent the user most recently picked,
   * instead of resetting to the first agent in the list on every reload.
   */
  lastAgentName?: string;
  /** Per-session model selection — keyed by sessionId so each session remembers its own model across reloads */
  sessionModel?: Record<string, ModelKey | undefined>;
}

// ============================================================================
// LocalStorage persistence
// ============================================================================

const STORE_KEY = 'opencode-model-store-v1';

/**
 * Cap the per-session maps (`sessionModel`, `sessionAgentName`). They're keyed
 * by durable session UUIDs, so without a cap they'd accumulate one entry per
 * session the user ever opens — a slow but real localStorage leak. Keep the
 * most-recently-touched N (map key order is a good-enough recency proxy).
 */
const MAX_SESSION_ENTRIES = 200;

function capSessionMap<V>(map: Record<string, V> | undefined): Record<string, V> | undefined {
  if (!map) return map;
  const keys = Object.keys(map);
  if (keys.length <= MAX_SESSION_ENTRIES) return map;
  const kept = keys.slice(-MAX_SESSION_ENTRIES);
  return Object.fromEntries(kept.map((k) => [k, map[k]])) as Record<string, V>;
}

/**
 * Guarantee the persisted store's shape no matter what localStorage holds.
 * Proven live (SampleCo 2026-08-26): a malformed `opencode-model-store-v1`
 * value crashed every route with "a.user is not iterable" because consumers
 * iterate `store.user` and `loadStore` returned `JSON.parse(raw)` unvalidated.
 * Corrupt or legacy data degrades to defaults — it never throws downstream.
 */
export function sanitizeModelStore(raw: unknown): ModelStore {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) return { user: [], recent: [], variant: {} };
  const objArray = <T>(v: unknown): T[] =>
    Array.isArray(v) ? (v.filter((e) => isObj(e)) as T[]) : [];
  const out: ModelStore = {
    user: objArray<UserEntry>(raw.user),
    recent: objArray<ModelKey>(raw.recent),
    variant: isObj(raw.variant) ? (raw.variant as ModelStore['variant']) : {},
  };
  if (isObj(raw.selectedModel)) out.selectedModel = raw.selectedModel as ModelStore['selectedModel'];
  if (isObj(raw.sessionAgentName)) out.sessionAgentName = raw.sessionAgentName as ModelStore['sessionAgentName'];
  if (typeof raw.lastAgentName === 'string') out.lastAgentName = raw.lastAgentName;
  if (isObj(raw.sessionModel)) out.sessionModel = raw.sessionModel as ModelStore['sessionModel'];
  return out;
}

function loadStore(): ModelStore {
  if (typeof window === 'undefined') {
    return { user: [], recent: [], variant: {} };
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return sanitizeModelStore(JSON.parse(raw));
  } catch {
    // ignore
  }
  return { user: [], recent: [], variant: {} };
}

let _store: ModelStore = loadStore();
const _listeners = new Set<() => void>();

function getStore(): ModelStore {
  return _store;
}

function setStore(next: ModelStore) {
  const capped = {
    ...next,
    sessionModel: capSessionMap(next.sessionModel),
    sessionAgentName: capSessionMap(next.sessionAgentName),
  };
  _store = capped;
  // Shared never-throw write — degrades gracefully and reclaims quota from
  // disposable caches instead of throwing if the bucket is full.
  safeSetItem(STORE_KEY, JSON.stringify(capped));
  for (const fn of _listeners) fn();
}

// On an identity change the previous user's picks must not survive in memory:
// the next `setStore` would write them back to storage under the new user.
registerIdentityReset(() => {
  _store = { user: [], recent: [], variant: {} };
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage-blocked context: the in-memory reset above is what matters.
  }
  for (const fn of _listeners) fn();
});

function subscribe(fn: () => void) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// The default-visibility rule is framework-free (`createModelVisibility`), so
// every host resolves the picker's default view identically.
export { computeLatestSet, hasUsableModel, isDefaultVisible } from '../core/models/model-visibility';

// ============================================================================
// Hook
// ============================================================================

export function useModelStore(
  allModels: FlatModel[],
  opts?: {
    connectedProviderIds?: Set<string>;
    // Free tier (no active paid sub): hides every Kortix managed model.
    freeTier?: boolean;
    /**
     * Canonical universe used to resolve default/heuristic visibility (the
     * "latest per family" set and each model's `releaseDate` lookup).
     * Defaults to `allModels`.
     *
     * `isVisible` must NOT be a function of which (possibly narrowed) array
     * a given call site happens to pass as `allModels` — different surfaces
     * (session picker vs. Settings > Models vs. command palette) otherwise
     * compute a different `latestSet`/`modelByKey` for the SAME model key,
     * so the same model can silently resolve to a different default
     * visibility (and therefore a different persisted 'show' write) on one
     * surface vs. another. Pass the full gateway catalog here from every
     * call site so default resolution is identical everywhere; `allModels`
     * keeps its existing meaning (what's actually rendered/iterated).
     */
    catalogModels?: FlatModel[];
  },
) {
  const store = useSyncExternalStore(subscribe, getStore, getStore);
  const connectedProviderIds = opts?.connectedProviderIds;
  const freeTier = opts?.freeTier ?? false;
  const catalogModels = opts?.catalogModels ?? allModels;

  // Compute latest set (for `isLatest`; `createModelVisibility` derives its own).
  const latestSet = useMemo(() => computeLatestSet(catalogModels), [catalogModels]);

  // Check if a model is visible — the framework-free rule, fed this store's pins.
  const isVisible = useMemo(
    () =>
      createModelVisibility({
        catalogModels,
        pins: store.user,
        connectedProviderIds,
        freeTier,
      }),
    [catalogModels, store.user, connectedProviderIds, freeTier],
  );

  // Check if a model is in the latest set
  const isLatest = useCallback(
    (model: ModelKey): boolean => {
      return latestSet.has(`${model.providerID}:${model.modelID}`);
    },
    [latestSet],
  );

  // Set visibility for a model
  const setVisibility = useCallback((model: ModelKey, show: boolean) => {
    const s = getStore();
    const index = s.user.findIndex(
      (x) => x.modelID === model.modelID && x.providerID === model.providerID,
    );
    const next = [...s.user];
    if (index >= 0) {
      next[index] = { ...next[index], visibility: show ? 'show' : 'hide' };
    } else {
      next.push({ ...model, visibility: show ? 'show' : 'hide' });
    }
    setStore({ ...s, user: next });
  }, []);

  // Clear every visibility override so all models revert to their default
  // (shown). Leaves recent/variant/selection state untouched.
  const resetVisibility = useCallback(() => {
    const s = getStore();
    if (s.user.length === 0) return;
    setStore({ ...s, user: [] });
  }, []);

  // Recent models
  const recentModels = useMemo(() => store.recent, [store.recent]);

  const pushRecent = useCallback((model: ModelKey) => {
    const s = getStore();
    const key = (m: ModelKey) => m.providerID + m.modelID;
    const existing = s.recent.filter((r) => key(r) !== key(model));
    const next = [model, ...existing].slice(0, 5);
    setStore({ ...s, recent: next });
  }, []);

  // Variant persistence
  const getVariant = useCallback(
    (model: ModelKey): string | undefined => {
      return store.variant[`${model.providerID}/${model.modelID}`];
    },
    [store.variant],
  );

  const setVariant = useCallback((model: ModelKey, value: string | undefined) => {
    const s = getStore();
    const k = `${model.providerID}/${model.modelID}`;
    setStore({ ...s, variant: { ...s.variant, [k]: value } });
  }, []);

  // Per-agent persisted model selection
  const getSelectedModel = useCallback(
    (agentName: string): ModelKey | undefined => {
      return store.selectedModel?.[agentName];
    },
    [store.selectedModel],
  );

  const setSelectedModel = useCallback((agentName: string, model: ModelKey | undefined) => {
    const s = getStore();
    const next = { ...s.selectedModel };
    if (model) {
      next[agentName] = model;
    } else {
      delete next[agentName];
    }
    setStore({ ...s, selectedModel: next });
  }, []);

  // Per-session agent name selection
  const getSessionAgentName = useCallback(
    (sessionId: string): string | undefined => store.sessionAgentName?.[sessionId],
    [store.sessionAgentName],
  );

  const setSessionAgentName = useCallback((sessionId: string, name: string | undefined) => {
    const s = getStore();
    // Read-then-write idempotency guard: `setSessionAgentName` writes to a
    // `useSyncExternalStore`-backed store whose snapshot identity changes on
    // every write. Without this guard, any render/effect path that re-fires the
    // setter with the SAME value drives an infinite render loop (React #185,
    // "Maximum update depth exceeded"). The loop was reported by Better Stack
    // as `Object.setSessionAgentName` on the co-worker session page (pattern
    // 351da943…). See `shouldSetSessionAgentName` for the rationale.
    const current = s.sessionAgentName?.[sessionId];
    if (!shouldSetSessionAgentName(current, name)) return;
    const next = { ...s.sessionAgentName };
    if (name) {
      next[sessionId] = name;
    } else {
      delete next[sessionId];
    }
    setStore({ ...s, sessionAgentName: next });
  }, []);

  // Globally last-used agent — fallback for dashboard (no sessionId) and a seed
  // for brand-new sessions. Written alongside the per-session slot so that
  // picking an agent anywhere sticks as the "last used" default.
  const lastAgentName = useMemo(() => store.lastAgentName, [store.lastAgentName]);

  const setLastAgentName = useCallback((name: string | undefined) => {
    const s = getStore();
    if (s.lastAgentName === name) return;
    setStore({ ...s, lastAgentName: name });
  }, []);

  // Per-session model selection (survives reload — user's explicit choice for this session)
  const getSessionModel = useCallback(
    (sessionId: string): ModelKey | undefined => store.sessionModel?.[sessionId],
    [store.sessionModel],
  );

  const setSessionModel = useCallback((sessionId: string, model: ModelKey | undefined) => {
    const s = getStore();
    const next = { ...s.sessionModel };
    if (model) {
      next[sessionId] = model;
    } else {
      delete next[sessionId];
    }
    setStore({ ...s, sessionModel: next });
  }, []);

  return {
    isVisible,
    isLatest,
    setVisibility,
    resetVisibility,
    recent: recentModels,
    pushRecent,
    getVariant,
    setVariant,
    getSelectedModel,
    setSelectedModel,
    getSessionAgentName,
    setSessionAgentName,
    lastAgentName,
    setLastAgentName,
    getSessionModel,
    setSessionModel,
    /** All user visibility preferences (for manage models dialog) */
    userPrefs: store.user,
  };
}
