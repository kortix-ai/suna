/**
 * Goals (project flag `goals`): what a person wants plus a definition of
 * done. An assigned agent works it in an owner session until an independent
 * verifier session passes every criterion.
 *
 * The API owns the lifecycle (`/v1/workspaces/:projectId/goals/*`): state,
 * pause, stop, owner, verifier, caps, wakes and verification live in the
 * goal record, and every write carries the `revision` it read (a stale one
 * throws `ProjectGoalConflictError` with the current goal). The goal's folder
 * in Files holds the brief (`GOAL.md`), `log.md` and `evidence/`; lifecycle
 * fields written into GOAL.md change nothing.
 *
 * Who may do what is the server's decision; `ProjectGoal.capabilities` says
 * it per goal for the caller. A person creates, pauses, resumes, stops,
 * restarts and answers; the owner session reports progress; only the
 * verifier session decides done.
 */

import { ApiError, backendApi } from '../../http/api-client';
import { generateSessionId } from '../../../platform/session-id';
import { mintWireMessageId } from '../../session/wire-message-id';
import type { ResourceBinding } from './manifest-spaces';
import { readDriveFile } from './drives';
import type { ProjectConfigSummary } from './projects';
import { createSessionPrompt } from './sessions';
import type { ProjectReminder } from './session-reminders';
import { unwrap } from './shared';

/** @deprecated Use `WorkspaceGoalStatus`. Kept permanently. */
export type ProjectGoalStatus =
  | 'draft'
  | 'active'
  | 'waiting_on_user'
  | 'waiting_external'
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'abandoned';

/** The workspace name of {@link ProjectGoalStatus}: the same type. */
export type WorkspaceGoalStatus = ProjectGoalStatus;

/** @deprecated Use `WorkspaceGoalCriterion`. Kept permanently. */
export interface ProjectGoalCriterion {
  id: string;
  text: string;
  met: boolean;
  /** A path relative to the goal folder, usually under `evidence/`. */
  evidence: string | null;
}

/** The workspace name of {@link ProjectGoalCriterion}: the same type. */
export type WorkspaceGoalCriterion = ProjectGoalCriterion;

/** @deprecated Use `WorkspaceGoalItem`. Kept permanently. */
export interface ProjectGoalItem {
  id: string;
  /** `task`: work. `ask`: something only a person can give. `wait`: an outside event. */
  kind: 'task' | 'ask' | 'wait';
  title: string;
  status: 'open' | 'doing' | 'done' | 'dropped';
  /** `agent`, `user`, or a person's name. */
  owner: string | null;
  /** UTC ISO 8601. */
  due: string | null;
}

/** The workspace name of {@link ProjectGoalItem}: the same type. */
export type WorkspaceGoalItem = ProjectGoalItem;

/** @deprecated Use `WorkspaceGoalSessionRef`. Kept permanently. */
export interface ProjectGoalSessionRef {
  id: string;
  /**
   * `owner`: the one session that works the goal now (the last `owner` is
   * current). `verifier`: an independent session that checked it. `coordinator`
   * is the owner in a legacy `goal.json`.
   */
  role: 'owner' | 'coordinator' | 'worker' | 'verifier';
  since: string;
}

/** The workspace name of {@link ProjectGoalSessionRef}: the same type. */
export type WorkspaceGoalSessionRef = ProjectGoalSessionRef;

/** @deprecated Use `WorkspaceGoalTransition`. Kept permanently. */
export interface ProjectGoalTransition {
  from: ProjectGoalStatus | null;
  to: ProjectGoalStatus;
  at: string;
  reason: string;
  by: string;
}

/** The workspace name of {@link ProjectGoalTransition}: the same type. */
export type WorkspaceGoalTransition = ProjectGoalTransition;

/**
 * A goal's definition and state in the shape GOAL.md front matter had
 * (`parseGoalFile`). `ProjectGoal.goal` holds it, derived from the server
 * record: `success_criteria[].met` is the owner's claim (`reported_met`),
 * never verification (read `ProjectGoal.criteria[].verified`), `items`,
 * `transitions` and `links` are empty (read `listProjectGoalEvents`), and
 * `body` is absent (read `getProjectGoalFiles(...).brief`). Lifecycle fields
 * written into a GOAL.md file change nothing: the API owns them.
 *
 * @deprecated Use `WorkspaceGoalDocument`. Kept permanently.
 */
export interface ProjectGoalDocument {
  version: 1;
  objective: string;
  status: ProjectGoalStatus;
  summary: string;
  success_criteria: ProjectGoalCriterion[];
  items: ProjectGoalItem[];
  sessions: ProjectGoalSessionRef[];
  reminder_id: string | null;
  transitions: ProjectGoalTransition[];
  verified_by: string | null;
  next_wake_at: string | null;
  /** The space the goal is grouped in (see `ResourceBinding`). Absent in older files. */
  space?: string | null;
  /** The agent assigned to the goal: its grants decide what the goal may do (`assigned_agent` in GOAL.md). */
  agent?: string | null;
  /** The person the goal is for: a user id. It answers the goal's questions and gets its updates. */
  assigned_user?: string | null;
  /** Related things: paths in the goal folder or Files, artifact, App, change request or session links. */
  links?: string[];
  /** The question the goal waits on the assigned user for, while `waiting_on_user`. */
  waiting_on?: string | null;
  /** The heartbeat interval while active, for example `4h`. */
  heartbeat_every?: string | null;
  /** Wakes per UTC day before the heartbeat waits for the next day. */
  max_wakes_per_day?: number | null;
  /** Sessions (owners and verifiers) the goal may use in total. */
  max_sessions?: number | null;
  /** The UTC day `wake_count` counts, `YYYY-MM-DD`. */
  wake_day?: string | null;
  wake_count?: number | null;
  last_wake_at?: string | null;
  /**
   * When a person paused the goal (UTC ISO 8601), or null. A paused goal keeps
   * its state; nothing wakes it until a person resumes it (`resumeProjectGoal`).
   */
  paused_at?: string | null;
  /** Who paused it: `person`, or a session id. */
  paused_by?: string | null;
  /** `goal.md`: read from GOAL.md. `goal.json`: a legacy folder. */
  format?: 'goal.md' | 'goal.json';
  /** GOAL.md's Markdown after the front matter. */
  body?: string;
}

/** The workspace name of {@link ProjectGoalDocument}: the same type. */
export type WorkspaceGoalDocument = ProjectGoalDocument;

/**
 * Why a goal needs a person to look at it.
 *
 * - `no_heartbeat`: an open goal has no active reminder, so nothing wakes it.
 * - `heartbeat_paused`: its reminder is paused.
 * - `heartbeat_failed`: the last wake could not start or reach its session.
 * - `missed_wake`: the next wake is more than 15 minutes overdue.
 * - `ask_overdue`: an open ask is past its due time.
 * - `verification_stalled`: verification started more than 24 hours ago.
 * - `unreadable`: GOAL.md (or a legacy goal.json) is missing or has no goal.
 * - `blocked`: the server records why the goal cannot go on by itself
 *   (`ProjectGoal.blockedReason`: credits, a cap, a lost owner, storage, the flag, setup).
 *
 * @deprecated Use `WorkspaceGoalIssue`. Kept permanently.
 */
export type ProjectGoalIssue =
  | 'no_heartbeat'
  | 'heartbeat_paused'
  | 'heartbeat_failed'
  | 'missed_wake'
  | 'ask_overdue'
  | 'verification_stalled'
  | 'unreadable'
  | 'blocked';

/** The workspace name of {@link ProjectGoalIssue}: the same type. */
export type WorkspaceGoalIssue = ProjectGoalIssue;

/** @deprecated Use `WorkspaceGoalHealth`. Kept permanently. */
export interface ProjectGoalHealth {
  /** `closed`: done or abandoned. `attention`: at least one issue. */
  state: 'healthy' | 'attention' | 'closed';
  issues: ProjectGoalIssue[];
}

/** The workspace name of {@link ProjectGoalHealth}: the same type. */
export type WorkspaceGoalHealth = ProjectGoalHealth;

/**
 * One goal as the API holds it (`ProjectGoalRecord`), in the shape the SDK
 * has always returned plus the server fields. Use `goalId` to address it and
 * send `revision` back on every write.
 *
 * @deprecated Use `WorkspaceGoal`. Kept permanently.
 */
export interface ProjectGoal {
  /** The folder name. Unique within the folder's parent. Use `goalId` to address a goal. */
  slug: string;
  /** `company`: a folder under `/Company/`. `personal`: any other folder (a person's own or a shared one). Read `folder` for where it is. */
  scope: 'company' | 'personal';
  driveId: string;
  /** The folder's path in Files, for example `/Users/<user_id>/Goals/bank-close`. */
  folder: string;
  /** The record in the shape of GOAL.md front matter (see `ProjectGoalDocument`). Never null for a server record. */
  goal: ProjectGoalDocument | null;
  /**
   * @deprecated The API owns the heartbeat and does not expose its reminder.
   * Always null; read `record.next_wake_at` and `record.last_wake_at`.
   */
  heartbeat: ProjectReminder | null;
  /** The goal's current owner session (`record.owner_session_id`). */
  coordinatorSessionId: string | null;
  health: ProjectGoalHealth;
  /** The project the goal belongs to. */
  projectId: string;
  /** The goal's stable id (`goal_id`): its page is `/workspaces/<projectId>/goals/<goalId>`. */
  goalId: string;
  /** Compare-and-set token: every write sends the revision it read. A stale one throws `ProjectGoalConflictError`. */
  revision: number;
  /** What the caller may do on this goal now. Show only these controls. */
  capabilities: ProjectGoalCapabilities;
  /** Why the goal cannot go on by itself, or null. */
  blockedReason: ProjectGoalBlockedReason | null;
  /** The latest independent verification, or null. */
  verification: ProjectGoalVerification | null;
  /** Done criteria: `reported_met` is the owner's claim, `verified` is the verifier's pass. */
  criteria: ProjectGoalCriterionStatus[];
  /** The server record as the API returned it. */
  record: ProjectGoalRecord;
}

/** The workspace name of {@link ProjectGoal}: the same type. */
export type WorkspaceGoal = ProjectGoal;

/**
 * States of the server record.
 *
 * @deprecated Use `WorkspaceGoalRecordState`. Kept permanently.
 */
export type ProjectGoalRecordState = 'draft' | 'active' | 'waiting_on_user' | 'verifying' | 'done' | 'stopped';

/** The workspace name of {@link ProjectGoalRecordState}: the same type. */
export type WorkspaceGoalRecordState = ProjectGoalRecordState;

/**
 * Why a goal cannot make progress by itself right now.
 * - `credits`: a wake was refused for credits; it goes on after a top-up and a person's resume.
 * - `wake_cap`: `max_wakes_per_day` reached; it goes on the next UTC day by itself.
 * - `session_cap`: `max_sessions` reached; a person raises the cap.
 * - `owner_lost`: the owner session failed and no successor took over; a person restarts it.
 * - `storage`: the goal's folder in Files could not be read or written.
 * - `flag_off`: the project's `goals` flag is off; nothing runs until it is on and a person resumes.
 * - `setup`: create did not finish; the API finishes it by itself.
 *
 * @deprecated Use `WorkspaceGoalBlockedReason`. Kept permanently.
 */
export type ProjectGoalBlockedReason = 'credits' | 'wake_cap' | 'session_cap' | 'owner_lost' | 'storage' | 'flag_off' | 'setup';

/** The workspace name of {@link ProjectGoalBlockedReason}: the same type. */
export type WorkspaceGoalBlockedReason = ProjectGoalBlockedReason;

/**
 * What the caller may do on a goal now. A person who may not sees no control.
 *
 * @deprecated Use `WorkspaceGoalCapabilities`. Kept permanently.
 */
export interface ProjectGoalCapabilities {
  read: boolean;
  edit: boolean;
  pause: boolean;
  resume: boolean;
  stop: boolean;
  restart: boolean;
  answer: boolean;
  edit_criteria: boolean;
}

/** The workspace name of {@link ProjectGoalCapabilities}: the same type. */
export type WorkspaceGoalCapabilities = ProjectGoalCapabilities;

/** @deprecated Use `WorkspaceGoalCriterionStatus`. Kept permanently. */
export interface ProjectGoalCriterionStatus {
  id: string;
  text: string;
  /** The owner's claim. Not verification: see `verified`. */
  reported_met: boolean;
  /** A path relative to the goal folder, under `evidence/`. */
  evidence: string | null;
  /** True only after a passed verification of the current criteria. */
  verified: boolean;
}

/** The workspace name of {@link ProjectGoalCriterionStatus}: the same type. */
export type WorkspaceGoalCriterionStatus = ProjectGoalCriterionStatus;

/** @deprecated Use `WorkspaceGoalVerification`. Kept permanently. */
export interface ProjectGoalVerification {
  attempt: number;
  verifier_session_id: string;
  criteria_revision: number;
  started_at: string;
  decided_at: string | null;
  outcome: 'pending' | 'pass' | 'fail';
  results: Array<{ criterion_id: string; result: 'pass' | 'fail' | 'inconclusive'; note: string }>;
  /** Evidence files the verdict covered: path → sha256 at verdict time. */
  evidence_hashes: Record<string, string>;
}

/** The workspace name of {@link ProjectGoalVerification}: the same type. */
export type WorkspaceGoalVerification = ProjectGoalVerification;

/**
 * A goal as `GET /workspaces/:projectId/goals` returns it (`packages/api-contract` `Goal`).
 *
 * @deprecated Use `WorkspaceGoalRecord`. Kept permanently.
 */
export interface ProjectGoalRecord {
  goal_id: string;
  project_id: string;
  revision: number;
  title: string;
  state: ProjectGoalRecordState;
  /** The question the goal waits on while `waiting_on_user`. */
  waiting_on: string | null;
  /** When a `waiting_on_user` goal wakes to chase, if it asked to. */
  chase_at: string | null;
  summary: string;
  paused_at: string | null;
  paused_by_user_id: string | null;
  stopped_at: string | null;
  blocked_reason: ProjectGoalBlockedReason | null;
  assigned_user_id: string | null;
  created_by_user_id: string;
  agent: string | null;
  space: string | null;
  drive_id: string;
  /** The folder in Files, for example `/Users/<user_id>/Goals/<slug>`. */
  folder: string;
  /** The same folder as the owner's sandbox sees it, for example `/drives/me/Goals/<slug>`. */
  box_folder: string;
  slug: string;
  owner_session_id: string | null;
  /** Every owner and verifier session the goal used, oldest first. */
  sessions: Array<{ id: string; role: 'owner' | 'verifier'; since: string }>;
  criteria_revision: number;
  criteria: ProjectGoalCriterionStatus[];
  verification: ProjectGoalVerification | null;
  heartbeat_every: string;
  next_wake_at: string | null;
  last_wake_at: string | null;
  max_wakes_per_day: number;
  /** Wakes the server admitted this UTC day. */
  wakes_today: number;
  max_sessions: number;
  /** `legacy_unverified`: imported from a folder; a `done` there was never verified by the API. */
  provenance: 'api' | 'legacy_unverified';
  created_at: string;
  updated_at: string;
  capabilities: ProjectGoalCapabilities;
}

/** The workspace name of {@link ProjectGoalRecord}: the same type. */
export type WorkspaceGoalRecord = ProjectGoalRecord;

/**
 * One line of a goal's audit trail (`GET …/goals/:goalId/events`).
 *
 * @deprecated Use `WorkspaceGoalEvent`. Kept permanently.
 */
export interface ProjectGoalEvent {
  id: string;
  goal_id: string;
  at: string;
  /** For example `created`, `activated`, `waiting`, `answered`, `paused`, `resumed`, `stopped`, `restarted`, `wake_admitted`, `wake_refused`, `verification_requested`, `verdict`, `handover`, `owner_adopted`, `criteria_changed`, `progress`, `blocked`, `unblocked`, `edited`. */
  kind: string;
  actor_kind: 'user' | 'session' | 'platform';
  actor_id: string | null;
  from_state: ProjectGoalRecordState | null;
  to_state: ProjectGoalRecordState | null;
  /** A short human-readable line. */
  message: string;
  data: Record<string, unknown>;
}

/** The workspace name of {@link ProjectGoalEvent}: the same type. */
export type WorkspaceGoalEvent = ProjectGoalEvent;

/**
 * A write's result: the document as before, plus the goal as the server holds it now (with its new `revision`).
 *
 * @deprecated Use `WorkspaceGoalWriteResult`. Kept permanently.
 */
export interface ProjectGoalWriteResult extends ProjectGoalDocument {
  projectGoal: ProjectGoal;
}

/** The workspace name of {@link ProjectGoalWriteResult}: the same type. */
export type WorkspaceGoalWriteResult = ProjectGoalWriteResult;

/**
 * A goal write sent a stale `revision` (`409 goal_conflict`): someone or
 * something changed the goal first. `goal` is the goal as it is now. Show it
 * and let the person decide again; never resend the write blindly.
 */
export class WorkspaceGoalConflictError extends ApiError {
  goal: ProjectGoal;
  constructor(source: ApiError, goal: ProjectGoal) {
    super(source.message || 'The goal changed.', {
      status: source.status,
      code: 'goal_conflict',
      details: source.details,
      data: source.data,
      response: source.response,
      name: 'ProjectGoalConflictError',
    });
    this.goal = goal;
  }
}

/** @deprecated Use `WorkspaceGoalConflictError`. Kept permanently. */
export const ProjectGoalConflictError = WorkspaceGoalConflictError;
/** @deprecated Use `WorkspaceGoalConflictError`. Kept permanently. */
export type ProjectGoalConflictError = WorkspaceGoalConflictError;

const CLOSED = new Set<ProjectGoalStatus>(['done', 'stopped', 'abandoned']);
const MISSED_WAKE_MS = 15 * 60_000;
const VERIFICATION_STALLED_MS = 24 * 3_600_000;

function isRecord(goal: ProjectGoalDocument | ProjectGoalRecord): goal is ProjectGoalRecord {
  return typeof (goal as ProjectGoalRecord).goal_id === 'string';
}

/**
 * A goal's health at `now` (ms). For a server record (`ProjectGoalRecord`) it
 * reads the server fields: `blocked_reason`, `next_wake_at` (a wake more than
 * 15 minutes overdue), and the start of a pending verification (more than 24
 * hours). A paused or waiting goal has no wake due, unless it asked to chase.
 * `heartbeat` is ignored for a record. A `ProjectGoalDocument` (a GOAL.md
 * read by hand) is judged by its heartbeat reminder, as before.
 */
export function goalHealth(
  goal: ProjectGoalDocument | ProjectGoalRecord | null,
  heartbeat: ProjectReminder | null,
  now: number = Date.now(),
): ProjectGoalHealth {
  if (!goal) return { state: 'attention', issues: ['unreadable'] };
  if (isRecord(goal)) return recordHealth(goal, now);
  if (CLOSED.has(goal.status)) return { state: 'closed', issues: [] };
  if (goal.paused_at && heartbeat?.state !== 'active') return { state: 'healthy', issues: [] };
  const issues: ProjectGoalIssue[] = [];
  const restartedAt = [...(goal.transitions ?? [])].reverse().find((t) => t.from === 'stopped')?.at;
  const waking = !!restartedAt && Date.parse(restartedAt) > now - MISSED_WAKE_MS;
  if (!heartbeat || heartbeat.state === 'done') {
    if (!waking) issues.push('no_heartbeat');
  }
  else if (heartbeat.state === 'paused') issues.push('heartbeat_paused');
  else if (heartbeat.last_status === 'failed') issues.push('heartbeat_failed');
  else if (heartbeat.next_fire_at && Date.parse(heartbeat.next_fire_at) < now - MISSED_WAKE_MS) issues.push('missed_wake');
  if ((goal.items ?? []).some((i) => i.kind === 'ask' && i.status === 'open' && i.due && Date.parse(i.due) < now)) {
    issues.push('ask_overdue');
  }
  if (goal.status === 'verifying') {
    const since = [...(goal.transitions ?? [])].reverse().find((t) => t.to === 'verifying')?.at;
    if (since && Date.parse(since) < now - VERIFICATION_STALLED_MS) issues.push('verification_stalled');
  }
  return { state: issues.length ? 'attention' : 'healthy', issues };
}

function recordHealth(goal: ProjectGoalRecord, now: number): ProjectGoalHealth {
  if (goal.state === 'done' || goal.state === 'stopped') return { state: 'closed', issues: [] };
  if (goal.paused_at) return { state: 'healthy', issues: [] };
  // The reason explains the stall; a wake check on top would say the same twice.
  if (goal.blocked_reason) return { state: 'attention', issues: ['blocked'] };
  const issues: ProjectGoalIssue[] = [];
  const overdue = !!goal.next_wake_at && Date.parse(goal.next_wake_at) < now - MISSED_WAKE_MS;
  if (goal.state === 'active') {
    if (!goal.next_wake_at) issues.push('no_heartbeat');
    else if (overdue) issues.push('missed_wake');
  } else if (goal.state === 'waiting_on_user' && goal.chase_at && overdue) {
    issues.push('missed_wake');
  }
  if (goal.state === 'verifying' && goal.verification?.outcome === 'pending' && Date.parse(goal.verification.started_at) < now - VERIFICATION_STALLED_MS) {
    issues.push('verification_stalled');
  }
  return { state: issues.length ? 'attention' : 'healthy', issues };
}

/** The record in the shape of GOAL.md front matter, for callers that read `ProjectGoal.goal`. */
function recordDocument(record: ProjectGoalRecord): ProjectGoalDocument {
  return {
    version: 1,
    objective: record.title,
    status: record.state,
    summary: record.summary,
    success_criteria: record.criteria.map((c) => ({ id: c.id, text: c.text, met: c.reported_met, evidence: c.evidence })),
    items: [],
    sessions: record.sessions,
    reminder_id: null,
    transitions: [],
    verified_by: record.verification?.outcome === 'pass' ? record.verification.verifier_session_id : null,
    next_wake_at: record.next_wake_at,
    space: record.space,
    agent: record.agent,
    assigned_user: record.assigned_user_id,
    links: [],
    waiting_on: record.waiting_on,
    heartbeat_every: record.heartbeat_every,
    max_wakes_per_day: record.max_wakes_per_day,
    max_sessions: record.max_sessions,
    wake_day: null,
    wake_count: record.wakes_today,
    last_wake_at: record.last_wake_at,
    paused_at: record.paused_at,
    paused_by: record.paused_by_user_id,
    format: 'goal.md',
  };
}

function toProjectGoal(record: ProjectGoalRecord, now: number = Date.now()): ProjectGoal {
  return {
    slug: record.slug,
    scope: record.folder.startsWith('/Company/') ? 'company' : 'personal',
    driveId: record.drive_id,
    folder: record.folder,
    goal: recordDocument(record),
    heartbeat: null,
    coordinatorSessionId: record.owner_session_id,
    health: goalHealth(record, null, now),
    projectId: record.project_id,
    goalId: record.goal_id,
    revision: record.revision,
    capabilities: record.capabilities,
    blockedReason: record.blocked_reason,
    verification: record.verification,
    criteria: record.criteria,
    record,
  };
}

function written(record: ProjectGoalRecord): ProjectGoalWriteResult {
  const projectGoal = toProjectGoal(record);
  return { ...recordDocument(record), projectGoal };
}

/** A `409 goal_conflict` with the current goal becomes a `ProjectGoalConflictError`; anything else is thrown as is. */
function conflict(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  const body = error.details as { error?: unknown; goal?: ProjectGoalRecord } | undefined;
  if (body?.error !== 'goal_conflict' || !body.goal || typeof body.goal.goal_id !== 'string') return error;
  return new WorkspaceGoalConflictError(error, toProjectGoal(body.goal));
}

/** Send one goal write; a `409 goal_conflict` throws `ProjectGoalConflictError`. */
async function goalWrite(send: () => Promise<{ data?: { goal: ProjectGoalRecord }; success: boolean; error?: Error }>): Promise<ProjectGoalRecord> {
  try {
    return unwrap(await send(), 'Goal request failed').goal;
  } catch (error) {
    throw conflict(error);
  }
}

const goalsPath = (projectId: string) => `/workspaces/${encodeURIComponent(projectId)}/goals`;
function goalPath(projectId: string, goalId: string): string {
  // `encodeURIComponent` keeps "." and "..", and the URL parser resolves them: `goals/..` would reach `/workspaces/:projectId`.
  if (goalId === '.' || goalId === '..') throw new Error(`Refused the request path ${goalsPath(projectId)}/${goalId}: a "." or ".." segment would send it to another endpoint. Pass ids exactly as Kortix prints them.`);
  return `${goalsPath(projectId)}/${encodeURIComponent(goalId)}`;
}

/** The route is not there for this caller: no such project route (404) or the `goals` flag is off (403 `feature_disabled`). */
function routeOff(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || (error.status === 403 && error.code === 'feature_disabled'));
}

/**
 * Every goal in the project the caller may read, from the API: their own,
 * the ones assigned to them, the ones in folders shared with them, and all
 * of them for a project admin. Empty when the `goals` flag is off.
 */
export async function listWorkspaceGoals(projectId: string, options?: { now?: number }): Promise<ProjectGoal[]> {
  let records: ProjectGoalRecord[];
  try {
    records = await listWorkspaceGoalRecords(projectId);
  } catch (error) {
    if (routeOff(error)) return [];
    throw error;
  }
  const now = options?.now ?? Date.now();
  return records.map((record) => toProjectGoal(record, now));
}

/** @deprecated Use `listWorkspaceGoals`. Kept permanently. */
export const listProjectGoals = listWorkspaceGoals;

/** The goal records the caller may read, as the API returns them; with `filter`, the goals that session owns or verifies. Unlike `listWorkspaceGoals` it throws when the route is off. */
export async function listWorkspaceGoalRecords(projectId: string, filter?: { role: 'owner' | 'verifier'; sessionId: string }): Promise<ProjectGoalRecord[]> {
  const query = filter ? `?${filter.role}_session_id=${encodeURIComponent(filter.sessionId)}` : '';
  return unwrap(await backendApi.get<{ goals: ProjectGoalRecord[] }>(`${goalsPath(projectId)}${query}`), 'Goals request failed').goals;
}

/** One goal by its `goal_id`. Throws `ApiError` 404 (no such goal) or 403 (no access). */
export async function getWorkspaceGoal(projectId: string, goalId: string, options?: { now?: number }): Promise<ProjectGoal> {
  const { goal } = unwrap(await backendApi.get<{ goal: ProjectGoalRecord }>(goalPath(projectId, goalId)), 'Goal request failed');
  return toProjectGoal(goal, options?.now);
}

/** @deprecated Use `getWorkspaceGoal`. Kept permanently. */
export const getProjectGoal = getWorkspaceGoal;

/** A page of a goal's audit trail, oldest first. Pass `nextCursor` back as `cursor` for the next page; null: no more. */
export async function listWorkspaceGoalEvents(
  projectId: string,
  goalId: string,
  options?: { cursor?: string | null },
): Promise<{ events: ProjectGoalEvent[]; nextCursor: string | null }> {
  const query = options?.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : '';
  const page = unwrap(
    await backendApi.get<{ events: ProjectGoalEvent[]; next_cursor: string | null }>(`${goalPath(projectId, goalId)}/events${query}`),
    'Goal events request failed',
  );
  return { events: page.events, nextCursor: page.next_cursor };
}

/** @deprecated Use `listWorkspaceGoalEvents`. Kept permanently. */
export const listProjectGoalEvents = listWorkspaceGoalEvents;

/** The goal a write addresses: its id and the revision the caller read. Other `ProjectGoal` fields are accepted and ignored. */
type GoalTarget = Pick<ProjectGoal, 'goalId' | 'revision'> & Partial<Omit<ProjectGoal, 'goalId' | 'revision'>>;

/**
 * Bind a goal to a space or an agent (`PATCH …/goals/:goalId`): null clears
 * one, an absent key keeps it. Grouping only: it grants nothing. A stale
 * `revision` throws `ProjectGoalConflictError`.
 */
export async function setWorkspaceGoalBinding(
  goal: GoalTarget,
  binding: ResourceBinding,
): Promise<ProjectGoalWriteResult> {
  const projectId = goal.projectId ?? goal.record?.project_id;
  if (!projectId) throw new Error('setProjectGoalBinding needs the goal\'s projectId.');
  return written(await goalWrite(() => backendApi.patch<{ goal: ProjectGoalRecord }>(goalPath(projectId, goal.goalId), { revision: goal.revision, ...binding })));
}

/** @deprecated Use `setWorkspaceGoalBinding`. Kept permanently. */
export const setProjectGoalBinding = setWorkspaceGoalBinding;

/** @deprecated Use `WorkspaceGoalFiles`. Kept permanently. */
export interface ProjectGoalFiles {
  /** `GOAL.md`: the brief (title, context, criteria as the agent reads them). */
  brief: string | null;
  /** `log.md`: the append-only timeline. */
  log: string | null;
  /** `notes.md`: request, constraints, threads, what was learned. */
  notes: string | null;
  /** `evidence/verification.md`: the independent verifier's report. */
  verification: string | null;
}

/** The workspace name of {@link ProjectGoalFiles}: the same type. */
export type WorkspaceGoalFiles = ProjectGoalFiles;

async function readText(driveId: string, path: string): Promise<string | null> {
  try {
    return await (await readDriveFile(driveId, path)).blob.text();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** A goal folder's text files. A missing file is null. */
export async function getWorkspaceGoalFiles(driveId: string, folder: string): Promise<ProjectGoalFiles> {
  const [brief, log, notes, verification] = await Promise.all([
    readText(driveId, `${folder}/GOAL.md`),
    readText(driveId, `${folder}/log.md`),
    readText(driveId, `${folder}/notes.md`),
    readText(driveId, `${folder}/evidence/verification.md`),
  ]);
  return { brief, log, notes, verification };
}

/** @deprecated Use `getWorkspaceGoalFiles`. Kept permanently. */
export const getProjectGoalFiles = getWorkspaceGoalFiles;

/**
 * A person stops a goal (`POST …/stop`): any open state → `stopped`. The API
 * removes the heartbeat and aborts the owner's running turn. A retry on a
 * goal that is already stopped finishes that cleanup and succeeds.
 */
export async function stopWorkspaceGoal(projectId: string, goal: GoalTarget, reason: string): Promise<ProjectGoalWriteResult> {
  return written(await goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goalId)}/stop`, { revision: goal.revision, reason })));
}

/** @deprecated Use `stopWorkspaceGoal`. Kept permanently. */
export const stopProjectGoal = stopWorkspaceGoal;

/**
 * A person pauses a goal (`POST …/pause`). The state does not change; no new
 * turn starts until a person resumes it. A turn already running finishes,
 * and the API refuses its lifecycle writes.
 */
export async function pauseWorkspaceGoal(projectId: string, goal: GoalTarget, reason: string): Promise<ProjectGoalWriteResult> {
  return written(await goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goalId)}/pause`, { revision: goal.revision, reason })));
}

/** @deprecated Use `pauseWorkspaceGoal`. Kept permanently. */
export const pauseProjectGoal = pauseWorkspaceGoal;

/** A person resumes a paused goal (`POST …/resume`): the heartbeat runs again and the owner wakes once. */
export async function resumeWorkspaceGoal(projectId: string, goal: GoalTarget): Promise<ProjectGoalWriteResult> {
  return written(await goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goalId)}/resume`, { revision: goal.revision })));
}

/** @deprecated Use `resumeWorkspaceGoal`. Kept permanently. */
export const resumeProjectGoal = resumeWorkspaceGoal;

/**
 * A person starts a stopped goal again (`POST …/restart`): `active` when it
 * has criteria, else `draft`. When the owner session is gone the API starts a
 * new one (within `max_sessions`).
 */
export async function restartWorkspaceGoal(projectId: string, goal: GoalTarget, reason: string): Promise<ProjectGoalWriteResult> {
  return written(await goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goalId)}/restart`, { revision: goal.revision, reason })));
}

/** @deprecated Use `restartWorkspaceGoal`. Kept permanently. */
export const restartProjectGoal = restartWorkspaceGoal;

/** A record write addresses the goal by its id and the revision the caller read. */
type RecordTarget = Pick<ProjectGoalRecord, 'goal_id' | 'revision'>;
/** The owner's lifecycle moves, and the verifier's `verdict`. Who may send which is the server's call. */
type GoalAction = 'activate' | 'wait' | 'progress' | 'request-verification' | 'handover' | 'verdict';

/** A goal session's lifecycle write (`POST …/goals/:goalId/<action>`): the record as the server holds it now. A stale `revision` throws `WorkspaceGoalConflictError`. */
export async function postWorkspaceGoalAction(projectId: string, goal: RecordTarget, action: GoalAction, body: Record<string, unknown>): Promise<ProjectGoalRecord> {
  return goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goal_id)}/${action}`, { revision: goal.revision, ...body }));
}

/** The owner sets a draft goal's done criteria (`PUT …/criteria`), sent as given. A stale `revision` throws `WorkspaceGoalConflictError`. */
export async function setWorkspaceGoalCriteria(projectId: string, goal: RecordTarget, criteria: string[]): Promise<ProjectGoalRecord> {
  return goalWrite(() => backendApi.put<{ goal: ProjectGoalRecord }>(`${goalPath(projectId, goal.goal_id)}/criteria`, { revision: goal.revision, criteria }));
}

/** The most done criteria a goal has (the API's limit). */
export const MAX_GOAL_CRITERIA = 8;
/** My Kortix's sandbox slugs (current and legacy): a session on one mounts no Files, so it cannot run `kortix goals`. */
const NO_FILES_SANDBOXES = new Set(['mykortix', 'meta']);

/**
 * The agent that owns a new goal. A goal lives in Files, so its owner needs
 * Files mounted: My Kortix (sandbox `mykortix`) has none. Named: that agent,
 * if it can. Omitted: the project's default agent, else the first enabled,
 * visible agent that can. Throws when none can.
 */
type GoalAgentCandidate = Pick<ProjectConfigSummary['agents'][number], 'name' | 'mode' | 'enabled' | 'hidden' | 'platform' | 'sandbox'>;

/** The project config fields that decide which agent works a goal. */
export interface GoalAgentConfig {
  default_agent?: string | null;
  agents?: readonly GoalAgentCandidate[];
}

function goalAgents(config: GoalAgentConfig): GoalAgentCandidate[] {
  return (config.agents ?? []).filter(
    (a) => a.enabled !== false && !a.hidden && !a.platform && !NO_FILES_SANDBOXES.has(a.sandbox ?? '') && !NO_FILES_SANDBOXES.has(a.name),
  );
}

/**
 * The agent a new goal runs when none is named: the project's default agent
 * if it can work a goal, else the first primary agent that can, else the
 * first that can. Null when none can (no agent with Files). A composer that
 * starts goals opens its agent picker on this agent.
 */
export function defaultGoalAgent(config: GoalAgentConfig): string | null {
  const agents = goalAgents(config);
  const pick = agents.find((a) => a.name === config.default_agent) ?? agents.find((a) => a.mode !== 'subagent') ?? agents[0];
  return pick?.name ?? null;
}

/** @deprecated Use `CreateWorkspaceGoalInput`. Kept permanently. */
export interface CreateProjectGoalInput {
  /** What should be true when the goal is done, in the person's words. The first line is the title; the rest is the context. */
  outcome: string;
  /** Done criteria someone else can check: at most 8. Blank lines are dropped. None: the agent writes them. */
  criteria?: string[];
  /** The agent that works it. It needs Files, so never My Kortix. Omitted: the server picks the project's default agent, else the first agent that can. */
  agent?: string | null;
  /** The person it is for: a user id. Omitted: nobody. */
  assignedUser?: string | null;
  /**
   * The goal's id (an RFC 4122 v4 UUID) and the create's idempotency key:
   * pass the same id to retry a create, and the API returns the same goal.
   * Omitted: `sessionId`, else a new id.
   */
  goalId?: string;
  /**
   * @deprecated Pass `goalId`. Still the idempotency key when `goalId` is
   * omitted: it is sent as the goal id. The API picks the owner session's id.
   */
  sessionId?: string;
  /** @deprecated Ignored: the API records the creation time. */
  now?: string;
}

/** The workspace name of {@link CreateProjectGoalInput}: the same type. */
export type CreateWorkspaceGoalInput = CreateProjectGoalInput;

/** @deprecated Use `CreatedWorkspaceGoal`. Kept permanently. */
export interface CreatedProjectGoal {
  slug: string;
  /** A goal a person creates from the app lives in their own folder. */
  scope: 'personal';
  driveId: string;
  folder: string;
  /** The owner session, already started on its first wake. Empty while the API still finishes the setup (`blockedReason: 'setup'`). */
  sessionId: string;
  /** The goal's id: the one sent, or the one generated. */
  goalId: string;
  /** The goal as the API holds it after the create. */
  goal: ProjectGoal;
}

/** The workspace name of {@link CreatedProjectGoal}: the same type. */
export type CreatedWorkspaceGoal = CreatedProjectGoal;

type GoalCreateBody = { goal_id: string; brief: string; criteria?: string[]; agent?: string; assigned_user_id?: string };

/** The create (`POST /workspaces/:projectId/goals`) sent as given, no trim or limit check: `createWorkspaceGoal` is the person flow on top. `goal_id` is the idempotency key. */
export async function createWorkspaceGoalRecord(projectId: string, body: GoalCreateBody): Promise<ProjectGoalRecord> {
  return goalWrite(() => backendApi.post<{ goal: ProjectGoalRecord }>(goalsPath(projectId), body));
}

/**
 * A person creates a goal (`POST /workspaces/:projectId/goals`). The API puts
 * it in the caller's own folder, writes GOAL.md and log.md, starts the owner
 * session with its heartbeat, and sends the first wake. `goalId` is the
 * idempotency key: a retry with the same id returns the same goal and starts
 * nothing twice. Throws before any request on an empty outcome or more than
 * 8 criteria; the API refuses an agent without Files.
 */
export async function createWorkspaceGoal(projectId: string, input: CreateProjectGoalInput): Promise<CreatedProjectGoal> {
  const text = input.outcome.trim();
  if (!text) throw new Error('Describe the outcome.');
  const [firstLine = '', ...rest] = text.split('\n');
  const context = briefContext(rest);
  const brief = context ? `${firstLine.trim()}\n${context}` : firstLine.trim();
  const criteria = (input.criteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length > MAX_GOAL_CRITERIA) throw new Error(`A goal has at most ${MAX_GOAL_CRITERIA} done criteria.`);
  const goalId = input.goalId ?? input.sessionId ?? generateSessionId();
  const payload: GoalCreateBody = { goal_id: goalId, brief };
  if (criteria.length) payload.criteria = criteria;
  if (input.agent) payload.agent = input.agent;
  if (input.assignedUser) payload.assigned_user_id = input.assignedUser;
  const goal = toProjectGoal(await createWorkspaceGoalRecord(projectId, payload));
  return {
    slug: goal.slug,
    scope: 'personal',
    driveId: goal.driveId,
    folder: goal.folder,
    sessionId: goal.coordinatorSessionId ?? '',
    goalId: goal.goalId,
    goal,
  };
}

/** @deprecated Use `createWorkspaceGoal`. Kept permanently. */
export const createProjectGoal = createWorkspaceGoal;

/**
 * A brief's lines after its first, as Markdown that reads as written: a plain
 * line right after a list item gets a blank line before it, so it is not
 * folded into that item (Markdown's lazy continuation).
 */
function briefContext(lines: string[]): string {
  const out: string[] = [];
  const item = /^\s*([-*+]|\d+[.)])\s/;
  for (const line of lines) {
    const previous = out.at(-1);
    if (previous !== undefined && item.test(previous) && line.trim() && !item.test(line) && !/^\s/.test(line)) out.push('');
    out.push(line.trimEnd());
  }
  return out.join('\n').trim();
}

/**
 * A person answers a goal (`POST …/answer`): the API queues the text into
 * the owner session, attributed to the caller, and a goal waiting on a
 * person goes back to active. `answerId` is the idempotency key: pass the
 * same id to retry, and the owner gets the answer once. Omitted: a new id.
 * Resolves when the answer is durable, not when it is read.
 */
export async function replyToWorkspaceGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'goalId'> & Partial<Omit<ProjectGoal, 'goalId'>>,
  text: string,
  options?: { answerId?: string },
): Promise<void> {
  // The body is not read: an answer route that replies `202` with no goal is as good as one that returns it.
  const response = await backendApi.post<{ goal?: ProjectGoalRecord }>(`${goalPath(projectId, goal.goalId)}/answer`, {
    answer_id: options?.answerId ?? generateSessionId(),
    text,
  });
  if (!response.success) throw conflict(response.error ?? new Error('Goal request failed'));
}

/** @deprecated Use `replyToWorkspaceGoal`. Kept permanently. */
export const replyToProjectGoal = replyToWorkspaceGoal;

/** What a session reads when a person asks it to turn the conversation into a goal. */
export const MAKE_GOAL_PROMPT =
  'Make this a goal. Load the kortix-goals skill, then turn what we discussed into a goal with `kortix goals new`: ' +
  'state the outcome, write the done criteria someone else can check, and start working it.';

/** "Make this a goal" from a chat: queue `MAKE_GOAL_PROMPT` into that session. */
export async function makeSessionGoal(projectId: string, sessionId: string): Promise<void> {
  await createSessionPrompt(projectId, sessionId, {
    clientMessageId: generateSessionId(),
    messageId: mintWireMessageId(),
    parts: [{ type: 'text', text: MAKE_GOAL_PROMPT }],
    remintOnDelivery: true,
  });
}
