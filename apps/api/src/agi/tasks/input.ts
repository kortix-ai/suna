/**
 * Request-body validation for the AGI task routes.
 *
 * Pure and synchronous on purpose: everything that can be decided without the
 * database is decided here, so a CHECK-constraint violation (23514) or a unique
 * violation (23505) can never be the error path a client sees. Whatever needs a
 * row — does this parent resolve, would it close a cycle — is left to the route,
 * which is why these return the parsed shape rather than issuing queries.
 */
import type { TaskPatch } from './store';
import {
  CLAIM_TTL_DEFAULT_SECONDS,
  CLAIM_TTL_MAX_SECONDS,
  CLAIM_TTL_MIN_SECONDS,
  NON_PATCHABLE_TASK_FIELDS,
  dedupeIds,
  hasTwoAssignees,
  isTaskOrigin,
  isTaskPriority,
  isTaskStatus,
  isTerminalTaskStatus,
  normalizeTitle,
  parseBlockedByInput,
  type TaskOrigin,
  type TaskPriority,
  type TaskStatus,
} from './wire';
import { UUID_V4_REGEX } from '../../projects/lib/serializers';

export interface ErrorBody {
  error: string;
  code?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: ErrorBody };

const SESSION_ID_MAX_LENGTH = 255;

const TWO_ASSIGNEES: ErrorBody = {
  error: 'A task has at most one assignee',
  code: 'two_assignees',
};

/** Absent and explicit null both mean "no value"; anything non-string is a
 *  caller error rather than something to coerce. Trimmed to null so a stray
 *  whitespace slug never becomes a real one. */
function nullableSlug(value: unknown, field: string): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: { error: `Invalid ${field}` } };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/** Free-form prose — preserved byte for byte, since indentation and trailing
 *  newlines are meaningful in a task body. */
function nullableText(value: unknown, field: string): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: { error: `Invalid ${field}` } };
  return { ok: true, value };
}

function nullableUuid(value: unknown, field: string): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !UUID_V4_REGEX.test(value)) {
    return { ok: false, error: { error: `Invalid ${field}` } };
  }
  return { ok: true, value };
}

export interface CreateTaskFields {
  title: string;
  body: string | null;
  goalSlug: string | null;
  project: string | null;
  parentId: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  agent: string | null;
  assigneeUserId: string | null;
  blockedBy: string[];
  triggerSlug: string | null;
  origin: TaskOrigin;
  originFingerprint: string | null;
}

export function parseCreateTaskBody(body: Record<string, unknown>): Parsed<CreateTaskFields> {
  const title = normalizeTitle(body.title);
  if ('error' in title) return { ok: false, error: { error: title.error } };

  // Origin is required with no default: who asked for this task is the one fact
  // nobody downstream can reconstruct, and guessing 'human' would corrupt it.
  const origin = body.origin;
  if (!isTaskOrigin(origin)) return { ok: false, error: { error: 'Invalid origin' } };

  const status = body.status === undefined ? 'backlog' : body.status;
  if (!isTaskStatus(status)) return { ok: false, error: { error: 'Invalid status' } };

  const priority = body.priority === undefined ? 'medium' : body.priority;
  if (!isTaskPriority(priority)) return { ok: false, error: { error: 'Invalid priority' } };

  const taskBody = nullableText(body.body, 'body');
  if (!taskBody.ok) return taskBody;
  const goalSlug = nullableSlug(body.goal_slug, 'goal_slug');
  if (!goalSlug.ok) return goalSlug;
  const project = nullableSlug(body.project, 'project');
  if (!project.ok) return project;
  const parentId = nullableUuid(body.parent_id, 'parent_id');
  if (!parentId.ok) return parentId;
  const agent = nullableSlug(body.agent, 'agent');
  if (!agent.ok) return agent;
  const assigneeUserId = nullableUuid(body.assignee_user_id, 'assignee_user_id');
  if (!assigneeUserId.ok) return assigneeUserId;
  const triggerSlug = nullableSlug(body.trigger_slug, 'trigger_slug');
  if (!triggerSlug.ok) return triggerSlug;
  const originFingerprint = nullableSlug(body.origin_fingerprint, 'origin_fingerprint');
  if (!originFingerprint.ok) return originFingerprint;

  if (hasTwoAssignees(agent.value, assigneeUserId.value)) return { ok: false, error: TWO_ASSIGNEES };

  let blockedBy: string[] = [];
  if (body.blocked_by !== undefined && body.blocked_by !== null) {
    const parsed = parseBlockedByInput(body.blocked_by);
    if ('error' in parsed) return { ok: false, error: { error: parsed.error } };
    blockedBy = parsed.ids;
  }

  return {
    ok: true,
    value: {
      title: title.title,
      body: taskBody.value,
      goalSlug: goalSlug.value,
      project: project.value,
      parentId: parentId.value,
      status,
      priority,
      agent: agent.value,
      assigneeUserId: assigneeUserId.value,
      blockedBy,
      triggerSlug: triggerSlug.value,
      origin,
      originFingerprint: originFingerprint.value,
    },
  };
}

/**
 * PATCH semantics: an ABSENT key leaves the column alone, an explicit null
 * clears it. The two must stay distinguishable, so every field is read with
 * `in` rather than by truthiness.
 */
export function parsePatchTaskBody(body: Record<string, unknown>): Parsed<TaskPatch> {
  for (const field of NON_PATCHABLE_TASK_FIELDS) {
    if (field in body) return { ok: false, error: { error: `${field} is not patchable` } };
  }

  const patch: TaskPatch = {};

  if ('title' in body) {
    const title = normalizeTitle(body.title);
    if ('error' in title) return { ok: false, error: { error: title.error } };
    patch.title = title.title;
  }
  if ('body' in body) {
    const taskBody = nullableText(body.body, 'body');
    if (!taskBody.ok) return taskBody;
    patch.body = taskBody.value;
  }
  if ('status' in body) {
    if (!isTaskStatus(body.status)) return { ok: false, error: { error: 'Invalid status' } };
    patch.status = body.status;
  }
  if ('priority' in body) {
    if (!isTaskPriority(body.priority)) return { ok: false, error: { error: 'Invalid priority' } };
    patch.priority = body.priority;
  }
  if ('goal_slug' in body) {
    const goalSlug = nullableSlug(body.goal_slug, 'goal_slug');
    if (!goalSlug.ok) return goalSlug;
    patch.goalSlug = goalSlug.value;
  }
  if ('project' in body) {
    const project = nullableSlug(body.project, 'project');
    if (!project.ok) return project;
    patch.project = project.value;
  }
  if ('parent_id' in body) {
    const parentId = nullableUuid(body.parent_id, 'parent_id');
    if (!parentId.ok) return parentId;
    patch.parentId = parentId.value;
  }
  if ('trigger_slug' in body) {
    const triggerSlug = nullableSlug(body.trigger_slug, 'trigger_slug');
    if (!triggerSlug.ok) return triggerSlug;
    patch.triggerSlug = triggerSlug.value;
  }
  if ('blocked_by' in body) {
    const parsed = parseBlockedByInput(body.blocked_by);
    if ('error' in parsed) return { ok: false, error: { error: parsed.error } };
    patch.blockedBy = parsed.ids;
  }

  const agent = 'agent' in body ? nullableSlug(body.agent, 'agent') : null;
  if (agent && !agent.ok) return agent;
  const assignee =
    'assignee_user_id' in body ? nullableUuid(body.assignee_user_id, 'assignee_user_id') : null;
  if (assignee && !assignee.ok) return assignee;

  if (agent?.ok && assignee?.ok && hasTwoAssignees(agent.value, assignee.value)) {
    return { ok: false, error: TWO_ASSIGNEES };
  }
  // R-14 as an implicit MOVE, not an error: naming a new assignee clears the
  // other kind in the same statement, so the single-assignee CHECK can never be
  // the thing that rejects a legitimate reassignment.
  if (agent?.ok) {
    patch.agent = agent.value;
    if (agent.value !== null) patch.assigneeUserId = null;
  }
  if (assignee?.ok) {
    patch.assigneeUserId = assignee.value;
    if (assignee.value !== null) patch.agent = null;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { error: 'No fields to update' } };
  }
  return { ok: true, value: patch };
}

function parseSessionId(value: unknown): Parsed<string> {
  if (typeof value !== 'string') return { ok: false, error: { error: 'session_id is required' } };
  const sessionId = value.trim();
  if (sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_LENGTH) {
    return { ok: false, error: { error: 'session_id is required' } };
  }
  return { ok: true, value: sessionId };
}

export interface ClaimFields {
  sessionId: string;
  ttlSeconds: number;
  status?: TaskStatus;
}

export function parseClaimBody(body: Record<string, unknown>): Parsed<ClaimFields> {
  const sessionId = parseSessionId(body.session_id);
  if (!sessionId.ok) return sessionId;

  let ttlSeconds = CLAIM_TTL_DEFAULT_SECONDS;
  if (body.ttl_seconds !== undefined && body.ttl_seconds !== null) {
    const raw = body.ttl_seconds;
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < CLAIM_TTL_MIN_SECONDS ||
      raw > CLAIM_TTL_MAX_SECONDS
    ) {
      return { ok: false, error: { error: 'Invalid ttl_seconds' } };
    }
    ttlSeconds = raw;
  }

  let status: TaskStatus | undefined;
  if (body.status !== undefined && body.status !== null) {
    if (!isTaskStatus(body.status)) return { ok: false, error: { error: 'Invalid status' } };
    // Claiming into done/cancelled would take a lease and drop it in the same
    // statement — the caller means `done`, which is a PATCH, not a claim.
    if (isTerminalTaskStatus(body.status)) {
      return { ok: false, error: { error: 'Cannot claim a task into a terminal status' } };
    }
    status = body.status;
  }

  return { ok: true, value: { sessionId: sessionId.value, ttlSeconds, status } };
}

export interface ReleaseFields {
  sessionId: string;
  status?: TaskStatus;
}

export function parseReleaseBody(body: Record<string, unknown>): Parsed<ReleaseFields> {
  const sessionId = parseSessionId(body.session_id);
  if (!sessionId.ok) return sessionId;

  let status: TaskStatus | undefined;
  if (body.status !== undefined && body.status !== null) {
    if (!isTaskStatus(body.status)) return { ok: false, error: { error: 'Invalid status' } };
    status = body.status;
  }
  return { ok: true, value: { sessionId: sessionId.value, status } };
}

/** Ids a create/patch must prove exist before it writes: the parent plus every
 *  blocker, de-duplicated so one round trip covers them all. */
export function idsNeedingResolution(input: {
  parentId?: string | null;
  blockedBy?: readonly string[];
}): string[] {
  const ids: string[] = [];
  if (input.parentId) ids.push(input.parentId);
  if (input.blockedBy) ids.push(...input.blockedBy);
  return dedupeIds(ids);
}
