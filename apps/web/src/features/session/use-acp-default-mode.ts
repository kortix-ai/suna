'use client';

/**
 * Bypass-all-by-default for a live ACP session's permission mode (owner ask,
 * 2026-07-22): a fresh session should auto-execute everything in its isolated
 * sandbox and NEVER prompt for per-tool permission. The user OPTS IN to a
 * stricter, prompts-you mode via the composer's mode pill; that opt-in is
 * persisted per AGENT (mirroring the harness-native model persistence in
 * `use-model-store.ts` — two agents on the same harness must not share a
 * remembered mode) so it survives across sessions and is NOT stomped by the
 * default-to-bypass logic.
 *
 * All the harness-neutral decisions live in the SDK (`resolveDefaultModeToApply`
 * / `pickMostPermissiveMode`, `@kortix/sdk`) — this hook only owns the React
 * lifecycle (apply-once-per-session guard) and the localStorage persistence.
 * Kept a standalone module so it never has to be edited into the crowded
 * model-selection / layout composer files.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  findAcpModeConfigOption,
  pickMostPermissiveMode,
  resolveDefaultModeToApply,
  type AcpSessionConfigOption,
} from '@kortix/sdk';
import { safeSetItem } from '@/lib/storage/managed-storage';

// ── Per-agent explicit-mode persistence ─────────────────────────────────────

interface AcpModeStore {
  /** Keyed by agent name — the mode value the user explicitly last picked. */
  byAgent: Record<string, string | undefined>;
}

const STORE_KEY = 'kortix-acp-session-mode-v1';

function loadStore(): AcpModeStore {
  if (typeof window === 'undefined') return { byAgent: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore — a corrupt blob must never break the composer.
  }
  return { byAgent: {} };
}

let _store: AcpModeStore = loadStore();
const _listeners = new Set<() => void>();

function getStore(): AcpModeStore {
  return _store;
}

function setStore(next: AcpModeStore): void {
  _store = next;
  safeSetItem(STORE_KEY, JSON.stringify(next));
  for (const fn of _listeners) fn();
}

function subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

export function getExplicitAgentMode(agentKey: string | null | undefined): string | undefined {
  if (!agentKey) return undefined;
  return getStore().byAgent[agentKey];
}

export function setExplicitAgentMode(agentKey: string | null | undefined, value: string | undefined): void {
  if (!agentKey) return;
  const s = getStore();
  if (s.byAgent[agentKey] === value) return;
  const next = { ...s.byAgent };
  if (value) next[agentKey] = value;
  else delete next[agentKey];
  setStore({ ...s, byAgent: next });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseAcpDefaultModeInput {
  /** Persist opt-in against this key (the session's bound agent name). */
  agentKey: string | null | undefined;
  /** The Kortix session id — the apply-once guard is keyed on it. */
  sessionId: string;
  /** `true` once the ACP session has bootstrapped (modes are known). */
  ready: boolean;
  /** Live session config options (carry the advertised `mode` option). */
  configOptions: readonly AcpSessionConfigOption[];
  /** The SAME `setConfigOption` the mode pill uses — every mode write, default
   *  or manual, goes through it so the harness stays the single source of truth. */
  setConfigOption: (configId: string, value: unknown) => Promise<unknown> | unknown;
}

export interface UseAcpDefaultModeResult {
  /** The live `mode` config option, if this harness advertises one. */
  modeOption: AcpSessionConfigOption | null;
  /** Record the user's explicit mode pick so it sticks across sessions and is
   *  never overridden by the default-to-bypass logic. Call from the pill's
   *  `onChange` (the actual `setConfigOption` write stays the caller's). */
  persistExplicitMode: (value: string) => void;
  /** Switch the session to its most-permissive advertised mode NOW (backs the
   *  "Allow everything" action) — resolves once the write settles, or `false`
   *  when this harness advertises no permissive mode to switch to. */
  applyMostPermissiveMode: () => Promise<boolean>;
}

export function useAcpDefaultMode({
  agentKey,
  sessionId,
  ready,
  configOptions,
  setConfigOption,
}: UseAcpDefaultModeInput): UseAcpDefaultModeResult {
  useSyncExternalStore(subscribe, getStore, getStore);

  const modeOption = useMemo(
    () => findAcpModeConfigOption(configOptions),
    [configOptions],
  );

  // Apply-once-per-session guard (mirrors `shouldAttemptDeferredModelApply`'s
  // ref): the default is applied a single time, the first render where the
  // session is ready AND the mode option has arrived. After that, whatever the
  // user does with the pill is theirs and is never re-stomped.
  const appliedForSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !modeOption) return;
    if (appliedForSessionRef.current === sessionId) return;
    appliedForSessionRef.current = sessionId;
    const value = resolveDefaultModeToApply({
      option: modeOption,
      explicitValue: getExplicitAgentMode(agentKey),
    });
    if (!value) return;
    void Promise.resolve(setConfigOption(modeOption.id, value)).catch(() => {
      // A failed default-apply must not wedge the guard — let a later render
      // (e.g. the option re-arriving after a reconnect) retry.
      if (appliedForSessionRef.current === sessionId) appliedForSessionRef.current = null;
    });
  }, [ready, modeOption, sessionId, agentKey, setConfigOption]);

  const persistExplicitMode = useCallback(
    (value: string) => setExplicitAgentMode(agentKey, value),
    [agentKey],
  );

  const applyMostPermissiveMode = useCallback(async () => {
    if (!modeOption) return false;
    const target = pickMostPermissiveMode(modeOption);
    if (!target) return false;
    if (String(modeOption.currentValue ?? '') !== target) {
      await setConfigOption(modeOption.id, target);
    }
    return true;
  }, [modeOption, setConfigOption]);

  return { modeOption, persistExplicitMode, applyMostPermissiveMode };
}
