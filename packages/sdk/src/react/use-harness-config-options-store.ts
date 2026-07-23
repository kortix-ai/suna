'use client';

/**
 * Pre-session source of a harness's OTHER advertised ACP session config
 * options — `mode`/`effort`/`reasoning_effort`/`fast-mode`/etc., everything
 * `findAcpModelConfigOption` does NOT classify as the model option (that has
 * its OWN dedicated cache/fallback — `use-harness-model-options-store.ts`,
 * `HARNESS_MODEL_OPTION_FALLBACK` — kept separate and untouched: it already
 * shipped, is tested, and the model control has its own bespoke composer
 * slot). 2026-07-22 extension: "the model selector when the session is
 * started and when it's not started should always be identical" — this store
 * is what makes the SAME true for every other config pill a native harness
 * (`ownsDefaultModel` — Claude Code, Codex) advertises, not just `model`.
 *
 * ONE generic mechanism (an array, not a pill-by-pill copy-paste): every
 * `select`-/`mode`-typed option a live session's `configOptions` carries
 * besides its model option gets cached here the instant it arrives, keyed by
 * harness — exactly the same cache-first/fallback-second/`[]`-when-genuinely-
 * unknown policy `use-harness-model-options-store.ts` established for
 * `model`. See `resolveHarnessConfigOptions`'s doc comment for the read path.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { AcpSessionConfigOption } from '../acp';
import { safeSetItem } from '../platform/storage/managed-storage';
import type { KortixHarness } from './harness-capabilities';

/** Everything about a config option worth remembering EXCEPT `currentValue`
 *  — same rationale as `CachedHarnessModelOption`
 *  (`use-harness-model-options-store.ts`): a cached/fallback option is never
 *  "the current value of a specific session", only "the shape of choices
 *  this harness offers". The composer stamps its OWN `currentValue` on top. */
export type CachedHarnessConfigOption = Pick<
  AcpSessionConfigOption,
  'id' | 'name' | 'description' | 'category' | 'type' | 'options'
>;

interface HarnessConfigOptionsStore {
  /** Keyed by `KortixHarness`. */
  byHarness: Partial<Record<KortixHarness, CachedHarnessConfigOption[]>>;
}

const STORE_KEY = 'kortix-harness-config-options-v1';

function loadStore(): HarnessConfigOptionsStore {
  if (typeof window === 'undefined') return { byHarness: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore — falls through to fallback list, never crashes the composer.
  }
  return { byHarness: {} };
}

let _store: HarnessConfigOptionsStore = loadStore();
const _listeners = new Set<() => void>();

function getStore(): HarnessConfigOptionsStore {
  return _store;
}

function setStore(next: HarnessConfigOptionsStore) {
  _store = next;
  safeSetItem(STORE_KEY, JSON.stringify(next));
  for (const fn of _listeners) fn();
}

function subscribe(fn: () => void) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function normalizeOption(option: AcpSessionConfigOption): CachedHarnessConfigOption {
  return {
    id: option.id,
    name: option.name,
    description: option.description,
    category: option.category,
    type: option.type,
    options: option.options,
  };
}

function sameCachedOptions(a: CachedHarnessConfigOption[], b: CachedHarnessConfigOption[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Non-hook read — used by non-React callers/tests. A React composer should
 *  prefer {@link useHarnessConfigOptionsCache} so it re-renders on a later
 *  write from a different tab/component. */
export function getCachedHarnessConfigOptions(
  harness: KortixHarness,
): CachedHarnessConfigOption[] | undefined {
  return getStore().byHarness[harness];
}

/**
 * Persists the LIVE non-model config options a session of this harness just
 * advertised, so the next pre-session composer for the same harness reuses
 * them instead of falling back to the static list. No-ops (skips the write +
 * listener notification) when the cached shape is already identical.
 */
export function cacheHarnessConfigOptions(
  harness: KortixHarness,
  options: readonly AcpSessionConfigOption[],
): void {
  const normalized = options.map(normalizeOption);
  const s = getStore();
  const existing = s.byHarness[harness];
  if (existing && sameCachedOptions(existing, normalized)) return;
  setStore({ byHarness: { ...s.byHarness, [harness]: normalized } });
}

/**
 * Static fallback per `ownsDefaultModel` harness, captured VERBATIM from a
 * real live session's `session/new` result (`kortix.acp_session_envelopes`,
 * local DB, 2026-07-22) — the exact adapter versions pinned in the sandbox
 * image at that date. `model` is excluded (see this file's own doc comment)
 * — every other `select`-/`mode`-typed option each harness advertised in the
 * SAME response:
 *
 * - `claude` (claude-agent-acp): `mode` (session permission mode — Auto/
 *   Manual/Accept Edits/Plan Mode/Don't Ask) and `effort` (reasoning effort —
 *   Default/Low/Medium/High/Xhigh/Max).
 * - `codex` (codex-acp): `mode` (approval/sandboxing preset — Read-only/
 *   Agent/Agent full access), `reasoning_effort` (low/medium/high/xhigh/max/
 *   ultra), and `fast-mode` (Off/On).
 *
 * ONE constant, deliberately not spread across call sites — when a pinned
 * adapter version changes what it advertises, this is the one place to paste
 * the new live payload. `resolveHarnessConfigOptions` always prefers the
 * CACHE over this; this only fires for a harness that has never had a live
 * session in this browser.
 */
export const HARNESS_CONFIG_OPTIONS_FALLBACK: Partial<
  Record<KortixHarness, CachedHarnessConfigOption[]>
> = {
  claude: [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      description: 'Session permission mode',
      options: [
        { name: 'Auto', value: 'auto', description: 'Use a model classifier to approve/deny permission prompts' },
        { name: 'Manual', value: 'default', description: 'Standard behavior, prompts for dangerous operations' },
        { name: 'Accept Edits', value: 'acceptEdits', description: 'Auto-accept file edit operations' },
        { name: 'Plan Mode', value: 'plan', description: 'Planning mode, no actual tool execution' },
        { name: "Don't Ask", value: 'dontAsk', description: "Don't prompt for permissions, deny if not pre-approved" },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      type: 'select',
      category: 'thought_level',
      description: 'Available effort levels for this model',
      options: [
        { name: 'Default', value: 'default' },
        { name: 'Low', value: 'low' },
        { name: 'Medium', value: 'medium' },
        { name: 'High', value: 'high' },
        { name: 'Xhigh', value: 'xhigh' },
        { name: 'Max', value: 'max' },
      ],
    },
  ],
  codex: [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      description: 'Approval and sandboxing preset for the session',
      options: [
        { name: 'Read-only', value: 'read-only', description: 'Requires approval to edit files and run commands.' },
        { name: 'Agent', value: 'agent', description: 'Read and edit files, and run commands.' },
        {
          name: 'Agent (full access)',
          value: 'agent-full-access',
          description: 'Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.',
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      category: 'thought_level',
      description: 'How much reasoning effort the model should use',
      options: [
        { name: 'low', value: 'low', description: 'Fast responses with lighter reasoning' },
        { name: 'medium', value: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { name: 'high', value: 'high', description: 'Greater reasoning depth for complex problems' },
        { name: 'xhigh', value: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
        { name: 'max', value: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        { name: 'ultra', value: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      type: 'select',
      category: 'model_config',
      description: '1.5x speed, increased usage',
      options: [
        { name: 'Off', value: 'off', description: 'Default speed, normal usage' },
        { name: 'On', value: 'on', description: '1.5x speed, increased usage' },
      ],
    },
  ],
};

/**
 * The single pre-session read path: the cached live payload if this browser
 * has ever seen one for `harness`, else the static fallback, else `[]` — the
 * honest "genuinely unknown" case (never claude/codex, since the fallback
 * always exists for them; always `[]` for a catalog harness — OpenCode, Pi —
 * which this store doesn't speak for at all).
 */
export function resolveHarnessConfigOptions(harness: KortixHarness): CachedHarnessConfigOption[] {
  return getCachedHarnessConfigOptions(harness) ?? HARNESS_CONFIG_OPTIONS_FALLBACK[harness] ?? [];
}

/**
 * React binding — re-renders the caller when ANY harness's cached options
 * change (same coarse-subscription rationale as
 * `useHarnessModelOptionsCache`).
 */
export function useHarnessConfigOptionsCache(): {
  resolve: (harness: KortixHarness) => CachedHarnessConfigOption[];
  cache: (harness: KortixHarness, options: readonly AcpSessionConfigOption[]) => void;
} {
  useSyncExternalStore(subscribe, getStore, getStore);
  const resolve = useCallback((harness: KortixHarness) => resolveHarnessConfigOptions(harness), []);
  const cache = useCallback((harness: KortixHarness, options: readonly AcpSessionConfigOption[]) => {
    cacheHarnessConfigOptions(harness, options);
  }, []);
  return { resolve, cache };
}
