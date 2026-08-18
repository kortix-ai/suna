/**
 * Bulk-nuke selection: pure rules over a snapshot of every registered worktree.
 *
 * `nuke --all` collects one PruneCandidate per registry slot (the impure probes
 * — live ports, `git status`, index mtime — live in cli.ts) and asks
 * `selectForPrune` which ones to tear down. Keeping the decision pure makes the
 * time rules testable without a registry or a git repo.
 */

export interface PruneCandidate {
  name: string;
  /** web or api port answering — a live stack is never nuked in bulk. */
  live: boolean;
  /** tracked, uncommitted changes in the checkout. */
  dirty: boolean;
  /** registry slot whose directory is gone — always safe to free. */
  missing: boolean;
  /** registry createdAt (ISO). */
  createdAt: string;
  /** epoch ms of the last activity (max of HEAD commit time and index mtime); null when unknown. */
  lastActivity: number | null;
}

export interface PruneRule {
  /** only slots created more than this many ms ago. */
  olderThanMs?: number;
  /** only slots whose last activity is more than this many ms ago. */
  idleMs?: number;
  /** nuke checkouts with uncommitted tracked changes too (default: keep them). */
  includeDirty: boolean;
}

export type PruneVerdict = { name: string; nuke: true; why: string } | { name: string; nuke: false; why: string };

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "30m" | "12h" | "3d" | "2w" → ms. Throws on anything else. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" — use <n>m|h|d|w, e.g. 3d or 12h`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2]]);
}

export function formatAge(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Order of precedence: a live stack is always kept; a missing directory is
 * always freed; then dirty, then the time rules. With no time rule every
 * non-live, non-dirty slot is selected.
 */
export function selectForPrune(candidates: PruneCandidate[], rule: PruneRule, nowMs: number): PruneVerdict[] {
  return candidates.map((c) => {
    if (c.live) return { name: c.name, nuke: false, why: 'stack is running' };
    if (c.missing) return { name: c.name, nuke: true, why: 'directory missing — freeing stale slot' };
    if (c.dirty && !rule.includeDirty) return { name: c.name, nuke: false, why: 'uncommitted changes (pass --include-dirty)' };
    const createdMs = Date.parse(c.createdAt);
    const age = Number.isFinite(createdMs) ? nowMs - createdMs : null;
    if (rule.olderThanMs !== undefined) {
      if (age === null) return { name: c.name, nuke: false, why: 'unknown createdAt' };
      if (age < rule.olderThanMs) return { name: c.name, nuke: false, why: `created ${formatAge(age)} ago (< --older-than)` };
    }
    if (rule.idleMs !== undefined) {
      const idle = c.lastActivity === null ? age : nowMs - c.lastActivity;
      if (idle === null) return { name: c.name, nuke: false, why: 'unknown activity' };
      if (idle < rule.idleMs) return { name: c.name, nuke: false, why: `active ${formatAge(idle)} ago (< --idle)` };
    }
    const parts: string[] = [];
    if (age !== null) parts.push(`created ${formatAge(age)} ago`);
    if (c.lastActivity !== null) parts.push(`last activity ${formatAge(nowMs - c.lastActivity)} ago`);
    if (c.dirty) parts.push('dirty');
    return { name: c.name, nuke: true, why: parts.join(', ') || 'no rule excludes it' };
  });
}
