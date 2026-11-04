/**
 * Goals (project flag `goals`): what a person wants plus a definition of
 * done. An assigned agent works it, wake after wake, until an independent
 * verifier session confirms it. A goal is a folder in the project's Files,
 * `/Company/Goals/<slug>/` by default: `GOAL.md` (front matter = definition
 * and state, `parseGoalFile`), `log.md` (append-only), `evidence/`. The
 * `kortix goals` CLI writes it inside the owner session's sandbox. Its
 * heartbeat is a loop on the owner session. Older folders hold `goal.json`.
 *
 * The folder stays the only source of truth; nothing here keeps a second
 * copy of a goal's state. The writes here are what a person does from the
 * app: stop a goal, answer its question.
 */

import { ApiError } from '../../http/api-client';
import { generateSessionId } from '../../../platform/session-id';
import { mintWireMessageId } from '../../session/wire-message-id';
import type { ResourceBinding } from './manifest-spaces';
import { getProjectDrive, listDriveFolder, readDriveFile, uploadDriveFile } from './drives';
import { formatGoalFile, parseGoalFile } from './goal-file';
import { createSessionPrompt } from './sessions';
import { deleteSessionReminder, listProjectReminders, type ProjectReminder } from './session-reminders';

export type ProjectGoalStatus =
  | 'draft'
  | 'active'
  | 'waiting_on_user'
  | 'waiting_external'
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'abandoned';

export interface ProjectGoalCriterion {
  id: string;
  text: string;
  met: boolean;
  /** A path relative to the goal folder, usually under `evidence/`. */
  evidence: string | null;
}

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

export interface ProjectGoalTransition {
  from: ProjectGoalStatus | null;
  to: ProjectGoalStatus;
  at: string;
  reason: string;
  by: string;
}

/**
 * A goal's definition and state: the front matter of `GOAL.md`
 * (`parseGoalFile`), or a legacy `goal.json`. `kortix goals` writes it.
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
  /** `goal.md`: read from GOAL.md. `goal.json`: a legacy folder. */
  format?: 'goal.md' | 'goal.json';
  /** GOAL.md's Markdown after the front matter. */
  body?: string;
}

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
 */
export type ProjectGoalIssue =
  | 'no_heartbeat'
  | 'heartbeat_paused'
  | 'heartbeat_failed'
  | 'missed_wake'
  | 'ask_overdue'
  | 'verification_stalled'
  | 'unreadable';

export interface ProjectGoalHealth {
  /** `closed`: done or abandoned. `attention`: at least one issue. */
  state: 'healthy' | 'attention' | 'closed';
  issues: ProjectGoalIssue[];
}

export interface ProjectGoal {
  /** The folder name. Unique within its scope. */
  slug: string;
  /** `company`: under `/Company/Goals`. `personal`: under the caller's own folder. */
  scope: 'company' | 'personal';
  driveId: string;
  /** The folder's path in Files, for example `/Company/Goals/bank-close`. */
  folder: string;
  /** Null when `goal.json` is missing or unreadable. */
  goal: ProjectGoalDocument | null;
  /** The coordinating session's active or paused heartbeat, or null. */
  heartbeat: ProjectReminder | null;
  coordinatorSessionId: string | null;
  health: ProjectGoalHealth;
}

const CLOSED = new Set<ProjectGoalStatus>(['done', 'stopped', 'abandoned']);
const MISSED_WAKE_MS = 15 * 60_000;
const VERIFICATION_STALLED_MS = 24 * 3_600_000;

/** A goal's health from its `goal.json` and its heartbeat, at `now` (ms). */
export function goalHealth(
  goal: ProjectGoalDocument | null,
  heartbeat: ProjectReminder | null,
  now: number = Date.now(),
): ProjectGoalHealth {
  if (!goal) return { state: 'attention', issues: ['unreadable'] };
  if (CLOSED.has(goal.status)) return { state: 'closed', issues: [] };
  const issues: ProjectGoalIssue[] = [];
  if (!heartbeat || heartbeat.state === 'done') issues.push('no_heartbeat');
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

async function folderDirs(driveId: string, path: string): Promise<string[]> {
  try {
    const { entries } = await listDriveFolder(driveId, path);
    return entries.filter((e) => e.type === 'dir').map((e) => e.path);
  } catch (error) {
    // No Goals folder yet.
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

async function readText(driveId: string, path: string): Promise<string | null> {
  try {
    return await (await readDriveFile(driveId, path)).blob.text();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function parseGoalJson(text: string | null): ProjectGoalDocument | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as ProjectGoalDocument;
    if (!value || typeof value !== 'object' || typeof value.objective !== 'string') return null;
    // A member can write any JSON here: keep only object entries of real arrays.
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    return {
      ...value,
      success_criteria: list(value.success_criteria),
      items: list(value.items),
      sessions: list(value.sessions),
      transitions: list(value.transitions),
      format: 'goal.json',
    };
  } catch {
    return null;
  }
}

/** The goal folder as a session sandbox sees it: Company at /drives/company, the caller's own folder at /drives/me. */
function goalBoxFolder(goal: Pick<ProjectGoal, 'scope' | 'slug'>): string {
  return `/drives/${goal.scope === 'company' ? 'company' : 'me'}/Goals/${goal.slug}`;
}

/** GOAL.md, else a legacy goal.json. */
async function readGoalDocument(driveId: string, folder: string): Promise<ProjectGoalDocument | null> {
  const md = await readText(driveId, `${folder}/GOAL.md`);
  if (md !== null) return parseGoalFile(md);
  return parseGoalJson(await readText(driveId, `${folder}/goal.json`));
}

/** The session that works the goal now: the last `owner` (or legacy `coordinator`). */
function ownerSessionId(goal: ProjectGoalDocument | null): string | null {
  return [...(goal?.sessions ?? [])].reverse().find((s) => s.role === 'owner' || s.role === 'coordinator')?.id ?? null;
}

/** The heartbeat: the goal's recorded reminder, else a reminder whose prompt names the goal folder. */
function findHeartbeat(
  reminders: readonly ProjectReminder[],
  goal: ProjectGoalDocument | null,
  scope: ProjectGoal['scope'],
  slug: string,
): ProjectReminder | null {
  const live = reminders.filter((r) => r.state !== 'done');
  const byId = goal?.reminder_id ? live.find((r) => r.id === goal.reminder_id) : undefined;
  if (byId) return byId;
  const boxFolder = goalBoxFolder({ scope, slug });
  return live.find((r) => new RegExp(`${boxFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(r.prompt)) ?? null;
}

/**
 * Every goal in the project the caller can see: Company goals first, then the
 * caller's own. Sorted by folder within each scope.
 */
export async function listProjectGoals(projectId: string, options?: { now?: number }): Promise<ProjectGoal[]> {
  const drive = await getProjectDrive(projectId).catch((error: unknown) => {
    // No Files in this project.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!drive) return [];
  const roots: Array<{ scope: ProjectGoal['scope']; path: string }> = [{ scope: 'company', path: '/Company/Goals' }];
  if (drive.personalFolder) roots.push({ scope: 'personal', path: `${drive.personalFolder}/Goals` });
  const folders = (
    await Promise.all(roots.map(async (root) => (await folderDirs(drive.driveId, root.path)).sort().map((folder) => ({ ...root, folder }))))
  ).flat();
  if (folders.length === 0) return [];
  const [{ reminders }, docs] = await Promise.all([
    listProjectReminders(projectId),
    Promise.all(folders.map((f) => readGoalDocument(drive.driveId, f.folder))),
  ]);
  const now = options?.now ?? Date.now();
  return folders.map((f, index) => {
    const goal = docs[index] ?? null;
    const slug = f.folder.split('/').at(-1) ?? f.folder;
    const heartbeat = findHeartbeat(reminders, goal, f.scope, slug);
    return {
      slug,
      scope: f.scope,
      driveId: drive.driveId,
      folder: f.folder,
      goal,
      heartbeat,
      coordinatorSessionId: ownerSessionId(goal) ?? heartbeat?.session_id ?? null,
      health: goalHealth(goal, heartbeat, now),
    };
  });
}

/**
 * Bind a goal to a space or an agent: read `goal.json` with its version,
 * merge `space` / `agent` (null clears one, an absent key keeps it) and write
 * it back with `If-Match`. A concurrent write throws `ApiError` 409. Returns
 * the document as written. Grouping only: it grants nothing.
 */
export async function setProjectGoalBinding(
  goal: Pick<ProjectGoal, 'driveId' | 'folder'>,
  binding: ResourceBinding,
): Promise<ProjectGoalDocument> {
  const path = `${goal.folder}/goal.json`;
  const { blob, version } = await readDriveFile(goal.driveId, path);
  const current = JSON.parse(await blob.text()) as ProjectGoalDocument;
  const next: ProjectGoalDocument = { ...current };
  if (binding.space !== undefined) next.space = binding.space;
  if (binding.agent !== undefined) next.agent = binding.agent;
  const body = new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`);
  await uploadDriveFile(goal.driveId, path, body, { ifMatch: version });
  return next;
}

export interface ProjectGoalFiles {
  /** `log.md`: the append-only timeline. */
  log: string | null;
  /** `notes.md`: request, constraints, threads, what was learned. */
  notes: string | null;
  /** `evidence/verification.md`: the independent verifier's verdict. */
  verification: string | null;
}

/** A goal folder's text files. A missing file is null. */
export async function getProjectGoalFiles(driveId: string, folder: string): Promise<ProjectGoalFiles> {
  const [log, notes, verification] = await Promise.all([
    readText(driveId, `${folder}/log.md`),
    readText(driveId, `${folder}/notes.md`),
    readText(driveId, `${folder}/evidence/verification.md`),
  ]);
  return { log, notes, verification };
}

/**
 * A person stops a goal (any open state → `stopped`): writes the state into
 * GOAL.md on the version it read (a concurrent write throws `ApiError` 409),
 * appends the move to `log.md`, and removes the heartbeat so nothing wakes it
 * again. Returns the document as written. Throws on a closed goal and on a
 * legacy `goal.json` folder.
 */
export async function stopProjectGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'driveId' | 'folder' | 'heartbeat'>,
  reason: string,
): Promise<ProjectGoalDocument> {
  const path = `${goal.folder}/GOAL.md`;
  const { blob, version } = await readDriveFile(goal.driveId, path);
  const current = parseGoalFile(await blob.text());
  if (!current) throw new Error(`${path} is not a goal file.`);
  if (CLOSED.has(current.status)) throw new Error(`The goal is already ${current.status}.`);
  const at = new Date().toISOString();
  const next: ProjectGoalDocument = {
    ...current,
    status: 'stopped',
    waiting_on: null,
    reminder_id: null,
    next_wake_at: null,
    transitions: [...current.transitions, { from: current.status, to: 'stopped', at, reason, by: 'person' }],
  };
  await uploadDriveFile(goal.driveId, path, new TextEncoder().encode(formatGoalFile(next)), { ifMatch: version });
  const log = (await readText(goal.driveId, `${goal.folder}/log.md`)) ?? '# Log\n';
  await uploadDriveFile(
    goal.driveId,
    `${goal.folder}/log.md`,
    new TextEncoder().encode(`${log.trimEnd()}\n- ${at} ${current.status} → stopped: ${reason}\n`),
  );
  if (goal.heartbeat?.session_id && goal.heartbeat.state !== 'done') {
    await deleteSessionReminder(projectId, goal.heartbeat.session_id, goal.heartbeat.id);
  }
  return next;
}

/**
 * Answer a goal: queue `text` into the owner session's inbox, which wakes it.
 * The prompt names the goal folder, so the owner knows which goal the answer
 * is for. Resolves when the prompt is durable, not when it is read.
 */
export async function replyToProjectGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'scope' | 'slug' | 'coordinatorSessionId'>,
  text: string,
): Promise<void> {
  if (!goal.coordinatorSessionId) throw new Error('The goal has no owner session to answer.');
  await queueText(projectId, goal.coordinatorSessionId, `Goal reply: ${goalBoxFolder(goal)}. The assigned user answers:\n\n${text}`);
}

async function queueText(projectId: string, sessionId: string, text: string): Promise<void> {
  await createSessionPrompt(projectId, sessionId, {
    clientMessageId: generateSessionId(),
    messageId: mintWireMessageId(),
    parts: [{ type: 'text', text }],
    remintOnDelivery: true,
  });
}

/** What a session reads when a person asks it to turn the conversation into a goal. */
export const MAKE_GOAL_PROMPT =
  'Make this a goal. Load the kortix-goals skill, then turn what we discussed into a goal with `kortix goals new`: ' +
  'state the outcome, write the done criteria someone else can check, and start working it.';

/** "Make this a goal" from a chat: queue `MAKE_GOAL_PROMPT` into that session. */
export async function makeSessionGoal(projectId: string, sessionId: string): Promise<void> {
  await queueText(projectId, sessionId, MAKE_GOAL_PROMPT);
}
