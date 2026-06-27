'use client';

import type { ModelKey } from '@kortix/sdk/react';
import { useEffect, useState } from 'react';

/**
 * Per-session model + agent selection, persisted locally. The lists come from
 * server-side hooks (`useProjectModels`, `useVisibleAgents`); this just remembers
 * which one is chosen for a session and feeds it to send. `null` means "use the
 * project/agent default" — we omit the field and the runtime decides.
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
    try {
      const raw = localStorage.getItem(storageKey(sessionId));
      if (raw) setPicks(JSON.parse(raw));
    } catch {}
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
