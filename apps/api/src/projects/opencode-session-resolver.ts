import type { Effect } from 'effect';
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

/** Last-activity time of a root: prefer `updated`, fall back to `created`. */
function activityOf(s: OpencodeSessionLite): number {
  return s.time?.updated ?? s.time?.created ?? 0;
}

/**
 * Deterministically choose the canonical root: the MOST-RECENTLY-ACTIVE root (no
 * parentID), tie-broken by newest creation, then by id so the order is total.
 * Null when no root.
 *
 * Why most-recently-active and not oldest-created: when opencode (or the whole
 * daemon) restarts mid-session it can leave TWO roots behind — the orphaned
 * pre-restart root, frozen mid-turn (a `bash[running]` part that never emits a
 * completion), and the fresh post-restart root the agent actually resumed into.
 * "Oldest root" deterministically picks the orphan, so a null-pin resolution
 * (e.g. a Slack/trigger session no browser ever opened) lands the UI + Slack
 * stream on a dead turn → the spinner never resolves. The live root is always
 * the one with the most recent activity, so that is the canonical choice.
 *
 * This only governs the FIRST resolution: once written, the pin is sticky (see
 * resolveRootSessionId — an existing pin is honored as long as it still exists),
 * so there is no churn from `updated` drifting afterward. The daemon also pins
 * the canonical root server-side at bootstrap, so this heuristic is a fallback.
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
    const a = activityOf(s);
    const b = activityOf(best);
    const ac = s.time?.created ?? 0;
    const bc = best.time?.created ?? 0;
    if (
      a > b ||
      (a === b && ac > bc) ||
      (a === b && ac === bc && s.id < best.id)
    ) {
      best = s;
    }
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
