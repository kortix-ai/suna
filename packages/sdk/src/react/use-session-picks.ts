'use client';

import { useEffect, useState } from 'react';
import type { ModelKey } from './use-model-store';

/**
 * Per-session model + agent selection, persisted locally. The lists come from the
 * server-side hooks (`useProjectModels`, `useVisibleAgents`); this just remembers
 * which one is chosen for a session and feeds it to send. `null` means "use the
 * project/agent default" — the field is omitted and the runtime decides. Owned by
 * the SDK so every host shares one implementation (and `useSession` can apply the
 * picks to send without the host wiring it).
 */
export interface SessionPicks {
  model: ModelKey | null;
  agent: string | null;
  setModel: (model: ModelKey | null) => void;
  setAgent: (agent: string | null) => void;
}

const storageKey = (sessionId: string) => `kortix:picks:${sessionId}`;

export function useSessionPicks(sessionId: string): SessionPicks {
  const [picks, setPicks] = useState<{ model: ModelKey | null; agent: string | null }>({
    model: null,
    agent: null,
  });

  useEffect(() => {
    // Always reset on session change — a host page instance is reused across
    // session navigation, so without resetting a new session would inherit the
    // previous one's picks (and persist them under the wrong key).
    try {
      const raw = localStorage.getItem(storageKey(sessionId));
      setPicks(raw ? JSON.parse(raw) : { model: null, agent: null });
    } catch {
      setPicks({ model: null, agent: null });
    }
  }, [sessionId]);

  const update = (patch: Partial<{ model: ModelKey | null; agent: string | null }>) =>
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
    setModel: (model) => update({ model }),
    setAgent: (agent) => update({ agent }),
  };
}
