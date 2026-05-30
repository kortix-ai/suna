/**
 * Pure OpenCode root-session resolution. Dependency-free so it can be unit
 * tested in isolation and shared by the mapping module. Mirrors the frontend's
 * use-canonical-opencode-session.ts logic — kept identical on purpose so client
 * and server converge on the same canonical root.
 */

export interface OpencodeSessionLite {
  id: string;
  parentID?: string | null;
  time?: { created?: number; updated?: number; archived?: number };
}

/**
 * Deterministically choose the canonical root: the OLDEST root (no parentID) by
 * creation time, tie-broken by id so the order is total. Null when no root.
 */
export function pickCanonicalRoot(
  sessions: OpencodeSessionLite[],
): OpencodeSessionLite | null {
  let best: OpencodeSessionLite | null = null;
  for (const s of sessions) {
    if (s.parentID) continue; // roots only
    if (!best) {
      best = s;
      continue;
    }
    const a = s.time?.created ?? 0;
    const b = best.time?.created ?? 0;
    if (a < b || (a === b && s.id < best.id)) best = s;
  }
  return best;
}

/**
 * Resolve the id the pin SHOULD hold: honor the pin if it still exists, else the
 * canonical root, else a just-created id.
 */
export function resolveRootSessionId(opts: {
  pinnedRootId: string | null;
  sessions: OpencodeSessionLite[];
  justCreatedId?: string | null;
}): string | null {
  const { pinnedRootId, sessions, justCreatedId } = opts;
  if (pinnedRootId && sessions.some((s) => s.id === pinnedRootId)) return pinnedRootId;
  const canonical = pickCanonicalRoot(sessions);
  if (canonical) return canonical.id;
  return justCreatedId ?? null;
}
