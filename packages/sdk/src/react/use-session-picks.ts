'use client';

import { useEffect, useState } from 'react';
import type { ModelKey } from './use-model-store';

/**
 * Per-session model + agent + variant selection, persisted locally. The lists come
 * from the server-side hooks (`useProjectModels`, `useVisibleAgents`); this just
 * remembers which one is chosen for a session and feeds it to send. `null` means
 * "use the project/agent default" — the field is omitted and the runtime decides.
 * Owned by the SDK so every host shares one implementation (and `useSession` can
 * apply the picks to send without the host wiring it).
 */
export interface SessionPicks {
  model: ModelKey | null;
  agent: string | null;
  /**
   * Reasoning effort / model variant (`'high'`, `'low'`, …), the third
   * per-session selection. `sendParts` already accepted it as a per-send
   * override, so every host kept it in a store of its own
   * (`useModelStore` in `apps/web`) and passed it on every call. It belongs
   * beside `model` and `agent`, persisted under the same key.
   */
  variant: string | null;
  setModel: (model: ModelKey | null) => void;
  setAgent: (agent: string | null) => void;
  setVariant: (variant: string | null) => void;
}

/** The three selections, without the setters — what is persisted. */
export type SessionPickValues = Pick<SessionPicks, 'model' | 'agent' | 'variant'>;

/** No selection at all: every field defaults to the project/agent default. */
export const EMPTY_SESSION_PICKS: SessionPickValues = { model: null, agent: null, variant: null };

const storageKey = (sessionId: string) => `kortix:picks:${sessionId}`;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A stored model is a `ModelKey` OBJECT (`{providerID, modelID, provider?}`),
 * not a wire string — `modelKeyToWire` is a separate conversion. Validating
 * the two required fields is what stops a half-written entry from reaching
 * `sendParts` as `{providerID: undefined}` and producing a prompt against no
 * model at all.
 */
function modelKeyOrNull(value: unknown): ModelKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bag = value as Record<string, unknown>;
  const providerID = stringOrNull(bag.providerID);
  const modelID = stringOrNull(bag.modelID);
  if (!providerID || !modelID) return null;
  const provider = stringOrNull(bag.provider);
  return { providerID, modelID, ...(provider ? { provider } : {}) };
}

/**
 * Parse a stored picks entry.
 *
 * Total: a corrupt entry yields no selection rather than throwing, because
 * this runs on the path a send reads. Every field is normalized to `string |
 * null` — an entry written before `variant` existed parses to `undefined`
 * there, and `undefined` is a different value on the wire than "no variant"
 * once `sendParts` reads it. Non-string values are dropped rather than passed
 * through: these become request fields.
 */
export function parseSessionPicks(raw: string | null | undefined): SessionPickValues {
  if (!raw) return { ...EMPTY_SESSION_PICKS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_SESSION_PICKS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY_SESSION_PICKS };
  }
  const bag = parsed as Record<string, unknown>;
  return {
    model: modelKeyOrNull(bag.model),
    agent: stringOrNull(bag.agent),
    variant: stringOrNull(bag.variant),
  };
}

export function useSessionPicks(sessionId: string): SessionPicks {
  const [picks, setPicks] = useState<SessionPickValues>({ ...EMPTY_SESSION_PICKS });

  useEffect(() => {
    // Always reset on session change — a host page instance is reused across
    // session navigation, so without resetting a new session would inherit the
    // previous one's picks (and persist them under the wrong key).
    try {
      setPicks(parseSessionPicks(localStorage.getItem(storageKey(sessionId))));
    } catch {
      setPicks({ ...EMPTY_SESSION_PICKS });
    }
  }, [sessionId]);

  const update = (patch: Partial<SessionPickValues>) =>
    setPicks((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(next));
      } catch {}
      return next;
    });

  return {
    model: picks.model,
    agent: picks.agent,
    variant: picks.variant,
    setModel: (model) => update({ model }),
    setAgent: (agent) => update({ agent }),
    setVariant: (variant) => update({ variant }),
  };
}
