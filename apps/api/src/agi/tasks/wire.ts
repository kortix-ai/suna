/**
 * The AGI task WIRE contract: vocabularies, the row→JSON serializer, the keyset
 * cursor codec, and every request-parameter parser.
 *
 * Everything here is pure — no database, no Hono context — because these are
 * the parts with edge cases worth testing directly (see wire.test.ts). The
 * routes are then a thin shell: parse, reject, query, serialize.
 */
import { UUID_V4_REGEX } from '../../projects/lib/serializers';
import type { agiTasks } from '@kortix/db';

export type AgiTaskRow = typeof agiTasks.$inferSelect;

// The vocabularies are text + CHECK in the database (they will move while `agi`
// is experimental), so the application owns the canonical list.
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'doing',
  'blocked',
  'review',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Terminal statuses. "Open" is defined everywhere as NOT one of these. */
export const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const satisfies readonly TaskStatus[];

export const OPEN_TASK_STATUSES = TASK_STATUSES.filter(
  (s): s is TaskStatus => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(s),
);

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_ORIGINS = ['human', 'agi', 'session', 'trigger'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/** Fields PATCH accepts. Anything else in the body is a 400, not a silent drop. */
export const PATCHABLE_TASK_FIELDS = [
  'title',
  'body',
  'status',
  'priority',
  'goal_slug',
  'project',
  'parent_id',
  'agent',
  'assignee_user_id',
  'blocked_by',
  'trigger_slug',
] as const;
export type PatchableTaskField = (typeof PATCHABLE_TASK_FIELDS)[number];

/** Server-owned fields. Naming one in a PATCH body is a caller bug worth saying
 *  out loud — silently ignoring it would let a client believe it moved a claim. */
export const NON_PATCHABLE_TASK_FIELDS = [
  'task_id',
  'workspace_id',
  'origin',
  'origin_fingerprint',
  'claim_session_id',
  'claimed_at',
  'claim_expires_at',
  'created_at',
  'updated_at',
] as const;

export const TASK_TITLE_MAX_LENGTH = 500;
export const TASK_LIST_MAX_LIMIT = 200;
export const TASK_LIST_DEFAULT_LIMIT = 50;
/** Children and blockers are returned whole, not paged — bounded so one
 *  pathological fan-out cannot turn a detail read into an unbounded response. */
export const TASK_RELATION_CAP = 200;

export const CLAIM_TTL_MIN_SECONDS = 30;
export const CLAIM_TTL_MAX_SECONDS = 86_400;
export const CLAIM_TTL_DEFAULT_SECONDS = 900;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function isTaskOrigin(value: unknown): value is TaskOrigin {
  return typeof value === 'string' && (TASK_ORIGINS as readonly string[]).includes(value);
}

export function isTerminalTaskStatus(value: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Row → wire. Pure in the row plus the server clock: `claimed` is DERIVED, never
 * stored, so an expired lease reads as unclaimed everywhere and a caller never
 * has to compare timestamps itself to know whether a claim is worth attempting
 * (R-19).
 */
export function serializeAgiTask(row: AgiTaskRow, now: Date = new Date()) {
  return {
    task_id: row.taskId,
    workspace_id: row.workspaceId,
    parent_id: row.parentId,
    goal_slug: row.goalSlug,
    project: row.project,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    agent: row.agent,
    assignee_user_id: row.assigneeUserId,
    blocked_by: row.blockedBy,
    trigger_slug: row.triggerSlug,
    claim_session_id: row.claimSessionId,
    claimed_at: row.claimedAt?.toISOString() ?? null,
    claim_expires_at: row.claimExpiresAt?.toISOString() ?? null,
    claimed:
      row.claimSessionId !== null &&
      row.claimExpiresAt !== null &&
      row.claimExpiresAt.getTime() > now.getTime(),
    origin: row.origin,
    origin_fingerprint: row.originFingerprint,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export type SerializedAgiTask = ReturnType<typeof serializeAgiTask>;

// ─── Keyset cursor ──────────────────────────────────────────────────────────
// Opaque to clients; keyed on the full default ordering (created_at DESC,
// task_id DESC) so a task inserted mid-page can never duplicate or skip a row
// the way an OFFSET would.

export interface TaskCursor {
  createdAt: string;
  taskId: string;
}

export function encodeTaskCursor(row: Pick<AgiTaskRow, 'createdAt' | 'taskId'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.taskId}`, 'utf8').toString('base64url');
}

/** Null for anything that is not a cursor this server minted — the route turns
 *  that into a 400 rather than silently listing from the top. */
export function decodeTaskCursor(raw: string): TaskCursor | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0) return null;
  const createdAt = decoded.slice(0, separator);
  const taskId = decoded.slice(separator + 1);
  if (!UUID_V4_REGEX.test(taskId)) return null;
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return null;
  return { createdAt: new Date(parsed).toISOString(), taskId };
}

// ─── Query parameter parsers ────────────────────────────────────────────────
// Each returns null for "invalid", which the route reports as
// 400 { error: 'Invalid <param>' }. Absent params take the documented default.

export type StatusFilter = { kind: 'all' } | { kind: 'in'; statuses: TaskStatus[] };

/**
 * Comma-separated statuses, union-ed. `open` expands to the five non-terminal
 * statuses; `all` disables the filter and may not be mixed with anything else
 * (a `status=all,done` would be a caller who thinks the two intersect).
 * Absent means `open` — the loop reads the queue far more often than history.
 */
export function parseStatusFilter(raw: string | undefined): StatusFilter | null {
  if (raw === undefined || raw === '') return { kind: 'in', statuses: [...OPEN_TASK_STATUSES] };
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.includes('all')) return parts.length === 1 ? { kind: 'all' } : null;

  const statuses: TaskStatus[] = [];
  for (const part of parts) {
    const expanded = part === 'open' ? OPEN_TASK_STATUSES : [part];
    for (const candidate of expanded) {
      if (!isTaskStatus(candidate)) return null;
      if (!statuses.includes(candidate)) statuses.push(candidate);
    }
  }
  return { kind: 'in', statuses };
}

export type AssigneeFilter =
  | { kind: 'agent'; agent: string }
  | { kind: 'user'; userId: string }
  | { kind: 'none' }
  | { kind: 'any' };

export function parseAssigneeFilter(raw: string): AssigneeFilter | null {
  if (raw === 'none') return { kind: 'none' };
  if (raw === 'any') return { kind: 'any' };
  if (raw.startsWith('agent:')) {
    const agent = raw.slice('agent:'.length);
    return agent.length > 0 ? { kind: 'agent', agent } : null;
  }
  if (raw.startsWith('user:')) {
    const userId = raw.slice('user:'.length);
    return UUID_V4_REGEX.test(userId) ? { kind: 'user', userId } : null;
  }
  return null;
}

/** A nullable-column filter: an exact value, or the literal `none` for IS NULL. */
export type NullableFilter = { kind: 'value'; value: string } | { kind: 'none' };

export function parseNullableFilter(raw: string): NullableFilter | null {
  if (raw === '') return null;
  return raw === 'none' ? { kind: 'none' } : { kind: 'value', value: raw };
}

export type ClaimFilter = 'free' | 'held';

export function parseClaimFilter(raw: string): ClaimFilter | null {
  return raw === 'free' || raw === 'held' ? raw : null;
}

export function parseBoundedInteger(
  raw: string | undefined,
  bounds: { min: number; max: number; fallback: number },
): number | null {
  if (raw === undefined || raw === '') return bounds.fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= bounds.min && value <= bounds.max ? value : null;
}

// ─── Body helpers ───────────────────────────────────────────────────────────

/** First-seen order, de-duplicated. Order is preserved because the detail route
 *  returns blockers IN blocked_by order — that ordering is the caller's, and the
 *  API is not entitled to reshuffle it. */
export function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `[]` is meaningful (clear every edge), so an absent key and an empty array
 *  must stay distinguishable — undefined means "leave alone". */
export function parseBlockedByInput(value: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'blocked_by must be an array of task ids' };
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID_V4_REGEX.test(entry)) {
      return { error: 'blocked_by must be an array of task ids' };
    }
  }
  return { ids: dedupeIds(value as string[]) };
}

export function normalizeTitle(value: unknown): { title: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'title is required' };
  const title = value.trim();
  if (title.length === 0) return { error: 'title is required' };
  if (title.length > TASK_TITLE_MAX_LENGTH) {
    return { error: `title must be at most ${TASK_TITLE_MAX_LENGTH} characters` };
  }
  return { title };
}

/** R-14, decided before any SQL runs: a 23514 from the single-assignee CHECK
 *  reaching the client as a 500 is a defect, so the check lives here too. */
export function hasTwoAssignees(agent: unknown, assigneeUserId: unknown): boolean {
  return (
    agent !== null && agent !== undefined && assigneeUserId !== null && assigneeUserId !== undefined
  );
}

/** Blockers come back in the order the task lists them, with ids that no longer
 *  resolve reported separately rather than silently dropped — R-17: the API
 *  never prunes `blocked_by`, so an unresolvable edge stays visible. */
export function orderBlockers(
  blockedBy: readonly string[],
  rows: readonly AgiTaskRow[],
): { blockers: AgiTaskRow[]; missing: string[] } {
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const blockers: AgiTaskRow[] = [];
  const missing: string[] = [];
  for (const id of blockedBy) {
    const row = byId.get(id);
    if (row) blockers.push(row);
    else missing.push(id);
  }
  return { blockers, missing };
}
