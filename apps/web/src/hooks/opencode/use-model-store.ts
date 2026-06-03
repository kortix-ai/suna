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

import { useMemo, useCallback, useSyncExternalStore } from 'react';
import type { FlatModel } from '@/components/session/session-chat-input';
import { safeSetItem } from '@/lib/storage/managed-storage';

// ============================================================================
// Types
// ============================================================================

export type ModelKey = { providerID: string; modelID: string };

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
  /**
   * User-chosen global default model (set during onboarding setup wizard).
   * Takes priority over agent.model but yields to per-session and per-agent selections.
   * This ensures the user's explicit choice during setup is respected everywhere.
   */
  globalDefault?: ModelKey;
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

function capSessionMap<V>(
  map: Record<string, V> | undefined,
): Record<string, V> | undefined {
  if (!map) return map;
  const keys = Object.keys(map);
  if (keys.length <= MAX_SESSION_ENTRIES) return map;
  const kept = keys.slice(-MAX_SESSION_ENTRIES);
  return Object.fromEntries(kept.map((k) => [k, map[k]])) as Record<string, V>;
}

function loadStore(): ModelStore {
  if (typeof window === 'undefined') {
    return { user: [], recent: [], variant: {} };
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
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
  next = {
    ...next,
    sessionModel: capSessionMap(next.sessionModel),
    sessionAgentName: capSessionMap(next.sessionAgentName),
  };
  _store = next;
  // Shared never-throw write — degrades gracefully and reclaims quota from
  // disposable caches instead of throwing if the bucket is full.
  safeSetItem(STORE_KEY, JSON.stringify(next));
  for (const fn of _listeners) fn();
}

function subscribe(fn: () => void) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ============================================================================
// Latest logic — direct port from SolidJS reference
// ============================================================================

/**
 * Fallback allowlist for the rare non-gateway model that carries no release-date
 * metadata: only the flagship shows out of the box, everything else is opt-in via
 * "Manage models". The managed Kortix gateway no longer flows through here — it
 * shows its whole catalog by default (see `isManagedGatewayModel` below).
 */
const DEFAULT_VISIBLE_MODEL_IDS = new Set<string>(['anthropic/claude-opus-4.8']);

/**
 * Provider id of the managed Kortix LLM gateway (see the sandbox's
 * `opencode.ts` provider config). It's a small, hand-picked catalog we control,
 * so every model in it is shown by default — `isVisible` short-circuits the
 * date-based "latest" heuristic for this provider. The newest-per-family
 * behaviour is kept for BYO providers, which is what it's for.
 */
const MANAGED_GATEWAY_PROVIDER_ID = 'kortix';

function isManagedGatewayModel(model: ModelKey): boolean {
  return model.providerID === MANAGED_GATEWAY_PROVIDER_ID;
}

function isDefaultVisible(model: ModelKey): boolean {
  return DEFAULT_VISIBLE_MODEL_IDS.has(model.modelID);
}

function isWithinMonths(dateStr: string | undefined, months: number): boolean {
  if (!dateStr) return false;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return false;
    const now = new Date();
    const diffMs = Math.abs(now.getTime() - date.getTime());
    const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.44);
    return diffMonths < months;
  } catch {
    return false;
  }
}

/**
 * Compute "latest" models: models released within 6 months,
 * grouped by provider then family, newest per family wins.
 */
function computeLatestSet(models: FlatModel[]): Set<string> {
  // Filter to recent models (within 6 months)
  const recent = models.filter((m) => isWithinMonths(m.releaseDate, 6));

  // Group by provider
  const byProvider = new Map<string, FlatModel[]>();
  for (const m of recent) {
    const list = byProvider.get(m.providerID) || [];
    list.push(m);
    byProvider.set(m.providerID, list);
  }

  const latestKeys = new Set<string>();

  for (const [, providerModels] of byProvider) {
    // Group by family
    const byFamily = new Map<string, FlatModel[]>();
    for (const m of providerModels) {
      const family = m.family || m.modelID;
      const list = byFamily.get(family) || [];
      list.push(m);
      byFamily.set(family, list);
    }

    // Pick newest per family
    for (const [, familyModels] of byFamily) {
      familyModels.sort((a, b) => {
        const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const db = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return db - da; // newest first
      });
      if (familyModels[0]) {
        latestKeys.add(`${familyModels[0].providerID}:${familyModels[0].modelID}`);
      }
    }
  }

  return latestKeys;
}

// ============================================================================
// Hook
// ============================================================================

export function useModelStore(allModels: FlatModel[]) {
  const store = useSyncExternalStore(subscribe, getStore, getStore);

  // Compute latest set
  const latestSet = useMemo(() => computeLatestSet(allModels), [allModels]);

  // Visibility map from user preferences
  const visibilityMap = useMemo(() => {
    const map = new Map<string, Visibility>();
    for (const item of store.user) {
      map.set(`${item.providerID}:${item.modelID}`, item.visibility);
    }
    return map;
  }, [store.user]);

  // Check if a model is visible (port of SolidJS visible() function)
  const isVisible = useCallback(
    (model: ModelKey): boolean => {
      const key = `${model.providerID}:${model.modelID}`;
      const state = visibilityMap.get(key);
      if (state === 'hide') return false;
      if (state === 'show') return true;
      // Managed Kortix gateway: show the whole curated catalog by default.
      // It's a small, hand-picked set we control, so every model is on unless
      // the user explicitly hides it.
      if (isManagedGatewayModel(model)) return true;
      if (latestSet.has(key)) return true;
      const m = allModels.find(
        (x) => x.providerID === model.providerID && x.modelID === model.modelID,
      );
      // No (or invalid) release metadata — the managed Kortix gateway case.
      // Default to showing only the flagship; every other model is opt-in via
      // "Manage models". Providers that DO carry release dates keep the
      // newest-per-family "latest" behaviour handled above.
      if (!m?.releaseDate) return isDefaultVisible(model);
      try {
        const d = new Date(m.releaseDate);
        if (isNaN(d.getTime())) return isDefaultVisible(model);
      } catch {
        return isDefaultVisible(model);
      }
      return false;
    },
    [visibilityMap, latestSet, allModels],
  );

  // Check if a model is in the latest set
  const isLatest = useCallback(
    (model: ModelKey): boolean => {
      return latestSet.has(`${model.providerID}:${model.modelID}`);
    },
    [latestSet],
  );

  // Set visibility for a model
  const setVisibility = useCallback(
    (model: ModelKey, show: boolean) => {
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
    },
    [],
  );

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

  // Global default model (set during onboarding setup wizard)
  const globalDefault = useMemo(() => store.globalDefault, [store.globalDefault]);

  const setGlobalDefault = useCallback((model: ModelKey | undefined) => {
    const s = getStore();
    // When setting a new global default, clear ALL per-agent and per-session
    // selections so the global default takes effect everywhere immediately.
    // Without this, stale per-agent/per-session data from previous interactions
    // would override the user's explicit setup choice.
    setStore({
      ...s,
      globalDefault: model,
      selectedModel: {},
      sessionModel: {},
    });
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
    globalDefault,
    setGlobalDefault,
    /** All user visibility preferences (for manage models dialog) */
    userPrefs: store.user,
  };
}
