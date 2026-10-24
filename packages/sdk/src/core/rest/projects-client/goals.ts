/**
 * Goals (project flag `goals`): an objective an agent owns until it is
 * verifiably done. A goal is a folder in the project's Files —
 * `/Company/Goals/<slug>/` or `<personal folder>/Goals/<slug>/` — whose
 * `goal.json` the `kortix goals` CLI writes inside the session's sandbox. Its
 * daily heartbeat is a reminder on the coordinating session.
 *
 * Read-only: these functions read the folder through the Files API and the
 * heartbeat through the reminders API. The folder stays the only source of
 * truth; nothing here keeps a second copy of a goal's state.
 */

import { ApiError } from '../../http/api-client';
import type { ResourceBinding } from './domains';
import { getProjectDrive, listDriveFolder, readDriveFile, uploadDriveFile } from './drives';
import { listProjectReminders, type ProjectReminder } from './session-reminders';

export type ProjectGoalStatus =
  | 'draft'
  | 'active'
  | 'waiting_on_user'
  | 'waiting_external'
  | 'verifying'
  | 'done'
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
  role: 'coordinator' | 'worker' | 'verifier';
  since: string;
}

export interface ProjectGoalTransition {
  from: ProjectGoalStatus | null;
  to: ProjectGoalStatus;
  at: string;
  reason: string;
  by: string;
}

/** `goal.json`, version 1, as `kortix goals` writes it. */
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
  /** The agent that owns the goal (see `ResourceBinding`). Absent in older files. */
  agent?: string | null;
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
 * - `unreadable`: `goal.json` is missing or is not valid JSON.
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

const CLOSED = new Set<ProjectGoalStatus>(['done', 'abandoned']);
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

function parseGoal(text: string | null): ProjectGoalDocument | null {
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
    };
  } catch {
    return null;
  }
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
  // The sandbox mounts Company at /drives/company and the caller's folder at /drives/me.
  const boxFolder = `/drives/${scope === 'company' ? 'company' : 'me'}/Goals/${slug}`;
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
    Promise.all(folders.map((f) => readText(drive.driveId, `${f.folder}/goal.json`).then(parseGoal))),
  ]);
  const now = options?.now ?? Date.now();
  return folders.map((f, index) => {
    const goal = docs[index] ?? null;
    const slug = f.folder.split('/').at(-1) ?? f.folder;
    const heartbeat = findHeartbeat(reminders, goal, f.scope, slug);
    const coordinator = [...(goal?.sessions ?? [])].reverse().find((s) => s.role === 'coordinator');
    return {
      slug,
      scope: f.scope,
      driveId: drive.driveId,
      folder: f.folder,
      goal,
      heartbeat,
      coordinatorSessionId: coordinator?.id ?? heartbeat?.session_id ?? null,
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
