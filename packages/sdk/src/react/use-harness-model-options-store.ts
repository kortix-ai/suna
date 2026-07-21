'use client';

/**
 * Pre-session source of model choices for an `ownsDefaultModel` harness
 * (Claude Code, Codex — see `agentModelPolicy` in `./harness-capabilities`).
 * These harnesses advertise their OWN selectable model list over ACP itself
 * (a `select`-typed `model` session config option — see
 * `isWritableAcpModelConfigOption`, `apps/web/src/features/session/
 * acp-composer-adapters.ts`), but that option only exists once a session is
 * LIVE. Before then — the composer the user actually types into before/while
 * a session starts — there is no protocol call that can answer "what models
 * does this harness support", so the composer needs a source of choices that
 * works with zero live session:
 *
 *  1. **Cache** (this store): the last real `model` config option a LIVE
 *     session of this harness actually advertised, persisted per harness so
 *     the NEXT pre-session composer for the same harness can reuse it. Kept
 *     deliberately small (one entry per {@link import('./harness-capabilities').KortixHarness})
 *     and durable (not a disposable/evictable cache) — losing it just means
 *     falling back to (2) below, not a broken picker.
 *  2. **Static fallback** ({@link HARNESS_MODEL_OPTION_FALLBACK}, in this same
 *     file so it's the one place to update): the choices the pinned adapter
 *     versions baked into the image are known (2026-07-21) to advertise,
 *     captured verbatim from real live sessions (`kortix.acp_session_envelopes`,
 *     dev DB) — see the constant's own doc comment for the exact source rows.
 *     Acceptable ONLY because the ACP adapters are version-pinned in the
 *     sandbox image (a version bump that changes the advertised list is a
 *     deliberate image change, not silent drift) — never used for a harness
 *     whose model list isn't independently known to be stable this way.
 *
 * `resolveHarnessModelOption` is the single read path a composer should use:
 * cache first, fallback second, `null` when neither exists (the honest
 * "we genuinely don't know" case — the composer keeps its static
 * non-interactive label there, exactly as it did before this store existed).
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { AcpSessionConfigOption } from '../acp';
import { safeSetItem } from '../platform/storage/managed-storage';
import type { KortixHarness } from './harness-capabilities';

/** Everything about a `model` config option worth remembering EXCEPT
 *  `currentValue` — a cached/fallback option is never "the current value of
 *  a specific session", only "the shape of choices this harness offers". The
 *  composer stamps its OWN `currentValue` on top (the persisted per-agent
 *  deferred pick, or the live session's actual confirmed value) — see
 *  `composer-chat-input.tsx`'s `harnessManagedModel` derivation. */
export type CachedHarnessModelOption = Pick<
  AcpSessionConfigOption,
  'id' | 'name' | 'description' | 'category' | 'type' | 'options'
>;

interface HarnessModelOptionsStore {
  /** Keyed by `KortixHarness`. */
  byHarness: Partial<Record<KortixHarness, CachedHarnessModelOption>>;
}

const STORE_KEY = 'kortix-harness-model-options-v1';

function loadStore(): HarnessModelOptionsStore {
  if (typeof window === 'undefined') return { byHarness: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore — falls through to fallback list, never crashes the composer.
  }
  return { byHarness: {} };
}

let _store: HarnessModelOptionsStore = loadStore();
const _listeners = new Set<() => void>();

function getStore(): HarnessModelOptionsStore {
  return _store;
}

function setStore(next: HarnessModelOptionsStore) {
  _store = next;
  safeSetItem(STORE_KEY, JSON.stringify(next));
  for (const fn of _listeners) fn();
}

function subscribe(fn: () => void) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function normalizeOption(option: AcpSessionConfigOption): CachedHarnessModelOption {
  return {
    id: option.id,
    name: option.name,
    description: option.description,
    category: option.category,
    type: option.type,
    options: option.options,
  };
}

function sameCachedOption(a: CachedHarnessModelOption, b: CachedHarnessModelOption): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Non-hook read — used by non-React callers/tests. A React composer should
 * prefer {@link useHarnessModelOptionsCache} so it re-renders on a later
 * write from a different tab/component.
 */
export function getCachedHarnessModelOption(
  harness: KortixHarness,
): CachedHarnessModelOption | undefined {
  return getStore().byHarness[harness];
}

/**
 * Persists the LIVE model config option a session of this harness just
 * advertised, so the next pre-session composer for the same harness reuses
 * it instead of falling back to the static list. No-ops (skips the write +
 * listener notification) when the cached shape is already identical —
 * keeping a live session's per-flush re-derivation of `harnessManagedModel`
 * from writing localStorage on every unrelated render.
 */
export function cacheHarnessModelOption(
  harness: KortixHarness,
  option: AcpSessionConfigOption,
): void {
  const normalized = normalizeOption(option);
  const s = getStore();
  const existing = s.byHarness[harness];
  if (existing && sameCachedOption(existing, normalized)) return;
  setStore({ byHarness: { ...s.byHarness, [harness]: normalized } });
}

/**
 * Static fallback per `ownsDefaultModel` harness, captured VERBATIM from a
 * real live session's `session/new` result (`kortix.acp_session_envelopes`,
 * dev DB, 2026-07-21) — the exact adapter versions pinned in the sandbox
 * image at that date:
 *
 * - `claude` (claude-agent-acp): `default`/`sonnet`/`opus`/`haiku`.
 * - `codex` (codex-acp): its GPT-5.x line.
 *
 * ONE constant, deliberately not spread across call sites — when a pinned
 * adapter version changes what it advertises, this is the one place to
 * paste the new live payload. `resolveHarnessModelOption` always prefers the
 * CACHE over this (a live session's own advertised list is closer to truth
 * than a snapshot frozen at write time); this only fires for a harness that
 * has never had a live session in this browser.
 */
export const HARNESS_MODEL_OPTION_FALLBACK: Partial<
  Record<KortixHarness, CachedHarnessModelOption>
> = {
  claude: {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    description: 'AI model to use',
    options: [
      {
        name: 'Default (recommended)',
        value: 'default',
        description: 'Sonnet 5 · Efficient for routine tasks',
      },
      { name: 'Sonnet', value: 'sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
      { name: 'Opus', value: 'opus', description: 'Opus 4.8 · Best for everyday, complex tasks' },
      { name: 'Haiku', value: 'haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
    ],
  },
  codex: {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    description: 'Model Codex uses for the session',
    options: [
      {
        name: 'GPT-5.6-Sol',
        value: 'gpt-5.6-sol',
        description: 'Latest frontier agentic coding model.',
      },
      {
        name: 'GPT-5.6-Terra',
        value: 'gpt-5.6-terra',
        description: 'Balanced agentic coding model for everyday work.',
      },
      {
        name: 'GPT-5.6-Luna',
        value: 'gpt-5.6-luna',
        description: 'Fast and affordable agentic coding model.',
      },
      {
        name: 'GPT-5.5',
        value: 'gpt-5.5',
        description: 'Frontier model for complex coding, research, and real-world work.',
      },
      { name: 'GPT-5.4', value: 'gpt-5.4', description: 'Strong model for everyday coding.' },
      {
        name: 'GPT-5.4-Mini',
        value: 'gpt-5.4-mini',
        description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      },
      {
        name: 'GPT-5.2',
        value: 'gpt-5.2',
        description: 'Optimized for professional work and long-running agents.',
      },
    ],
  },
};

/**
 * The single pre-session read path: the cached live payload if this browser
 * has ever seen one for `harness`, else the static fallback, else `null` —
 * the honest "genuinely unknown" case a composer should degrade to its
 * static label for. Cache takes priority over the fallback unconditionally:
 * a real advertised list (even one from weeks ago) is closer to truth than a
 * frozen snapshot.
 */
export function resolveHarnessModelOption(harness: KortixHarness): CachedHarnessModelOption | null {
  return getCachedHarnessModelOption(harness) ?? HARNESS_MODEL_OPTION_FALLBACK[harness] ?? null;
}

/**
 * React binding — re-renders the caller when ANY harness's cached option
 * changes (the store is small enough, and writes rare enough — at most once
 * per bootstrapped live session — that a coarser subscription isn't worth a
 * per-harness selector).
 */
export function useHarnessModelOptionsCache(): {
  resolve: (harness: KortixHarness) => CachedHarnessModelOption | null;
  cache: (harness: KortixHarness, option: AcpSessionConfigOption) => void;
} {
  useSyncExternalStore(subscribe, getStore, getStore);
  const resolve = useCallback((harness: KortixHarness) => resolveHarnessModelOption(harness), []);
  const cache = useCallback((harness: KortixHarness, option: AcpSessionConfigOption) => {
    cacheHarnessModelOption(harness, option);
  }, []);
  return { resolve, cache };
}
