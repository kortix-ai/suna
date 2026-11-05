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
 * app: create a goal, pause, resume or stop it, answer its question.
 */

import { ApiError } from '../../http/api-client';
import { generateSessionId } from '../../../platform/session-id';
import { mintWireMessageId } from '../../session/wire-message-id';
import type { ResourceBinding } from './manifest-spaces';
import { getProjectDrive, listDriveFolder, readDriveFile, uploadDriveFile } from './drives';
import { formatGoalFile, parseGoalFile } from './goal-file';
import { getProjectDetail, type ProjectConfigSummary } from './projects';
import { createProjectSession, createSessionPrompt, getProjectSession } from './sessions';
import {
  createSessionReminder,
  deleteSessionReminder,
  listProjectReminders,
  listSessionReminders,
  updateSessionReminder,
  type ProjectReminder,
} from './session-reminders';

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
  // A person paused it: the disabled heartbeat is the pause, and nothing is due. A heartbeat
  // that still runs means GOAL.md alone claims the pause (any session can write it): judge it as any other.
  if (goal.paused_at && heartbeat?.state !== 'active') return { state: 'healthy', issues: [] };
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
    paused_at: null,
    paused_by: null,
    reminder_id: null,
    next_wake_at: null,
    transitions: [...current.transitions, { from: current.status, to: 'stopped', at, reason, by: 'person' }],
  };
  await uploadDriveFile(goal.driveId, path, new TextEncoder().encode(formatGoalFile(next)), { ifMatch: version });
  await appendGoalLog(goal, `- ${at} ${current.status} → stopped: ${reason}`);
  if (goal.heartbeat?.session_id && goal.heartbeat.state !== 'done') {
    await deleteSessionReminder(projectId, goal.heartbeat.session_id, goal.heartbeat.id);
  }
  return next;
}

/** Append one line to the goal's `log.md` (created when missing). */
async function appendGoalLog(goal: Pick<ProjectGoal, 'driveId' | 'folder'>, line: string): Promise<void> {
  const log = (await readText(goal.driveId, `${goal.folder}/log.md`)) ?? '# Log\n';
  await uploadDriveFile(goal.driveId, `${goal.folder}/log.md`, new TextEncoder().encode(`${log.trimEnd()}\n${line}\n`));
}

/** Read GOAL.md with its version. Throws on a folder without one (a legacy `goal.json`). */
async function readGoalForWrite(goal: Pick<ProjectGoal, 'driveId' | 'folder'>): Promise<{ doc: ProjectGoalDocument; version: string | null }> {
  const path = `${goal.folder}/GOAL.md`;
  const { blob, version } = await readDriveFile(goal.driveId, path);
  const doc = parseGoalFile(await blob.text());
  if (!doc) throw new Error(`${path} is not a goal file.`);
  return { doc, version };
}

/**
 * A person pauses a goal: GOAL.md records `paused_at` on the version it read
 * (a concurrent write throws `ApiError` 409), `log.md` records the reason,
 * and the heartbeat is disabled. The state does not change, so resuming picks
 * up where the goal was. A turn already running finishes; no new one starts.
 * Throws on a closed goal. On a goal GOAL.md already records as paused (a
 * retry after the heartbeat update failed) it only disables the heartbeat.
 */
export async function pauseProjectGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'driveId' | 'folder' | 'heartbeat'>,
  reason: string,
): Promise<ProjectGoalDocument> {
  const { doc: current, version } = await readGoalForWrite(goal);
  if (CLOSED.has(current.status)) throw new Error(`The goal is already ${current.status}.`);
  let next = current;
  // Already paused: a retry after the heartbeat update failed. Finish that step only.
  if (!current.paused_at) {
    const at = new Date().toISOString();
    next = { ...current, paused_at: at, paused_by: 'person' };
    await uploadDriveFile(goal.driveId, `${goal.folder}/GOAL.md`, new TextEncoder().encode(formatGoalFile(next)), { ifMatch: version });
    await appendGoalLog(goal, `- ${at} paused: ${reason}`);
  }
  if (goal.heartbeat?.session_id && goal.heartbeat.state === 'active') {
    await updateSessionReminder(projectId, goal.heartbeat.session_id, goal.heartbeat.id, { enabled: false });
  }
  return next;
}

/**
 * A person resumes a paused goal, in this order: the heartbeat is enabled
 * again, GOAL.md clears `paused_at` (`log.md` records it), and the owner
 * session wakes now (its turn end re-arms a heartbeat that went missing). A
 * retry after a later step failed finishes the steps left: a goal GOAL.md
 * already records as running gets its heartbeat enabled, and a wake when it
 * has no live heartbeat.
 */
export async function resumeProjectGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'driveId' | 'folder' | 'heartbeat' | 'scope' | 'slug' | 'coordinatorSessionId'>,
): Promise<ProjectGoalDocument> {
  const { doc: current, version } = await readGoalForWrite(goal);
  if (CLOSED.has(current.status)) throw new Error(`The goal is already ${current.status}.`);
  const pausedAt = current.paused_at;
  // 1. The heartbeat first: whatever fails after it, something still wakes the goal.
  const heartbeatLive = goal.heartbeat?.session_id && goal.heartbeat.state !== 'done';
  if (goal.heartbeat?.session_id && goal.heartbeat.state === 'paused') {
    await updateSessionReminder(projectId, goal.heartbeat.session_id, goal.heartbeat.id, { enabled: true });
  }
  // 2. Clear the pause. Already clear: a retry after a later step failed.
  let next = current;
  if (pausedAt) {
    next = { ...current, paused_at: null, paused_by: null };
    await uploadDriveFile(goal.driveId, `${goal.folder}/GOAL.md`, new TextEncoder().encode(formatGoalFile(next)), { ifMatch: version });
    await appendGoalLog(goal, `- ${new Date().toISOString()} resumed`);
  }
  // 3. Wake the owner now: once per pause (its id names the pause, so a repeat is deduped), or
  // on a retry when no heartbeat would ever wake it.
  const owner = ownerSessionId(current) ?? goal.coordinatorSessionId;
  const wake = `${goalWakePrompt(goalBoxFolder(goal))} A person resumed it.`;
  if (owner && pausedAt) await queueText(projectId, owner, wake, `goal-resume:${owner}:${pausedAt}`);
  else if (owner && !heartbeatLive) await queueText(projectId, owner, wake);
  return next;
}

/**
 * A person starts a stopped goal again, in place: GOAL.md moves `stopped` →
 * `active` (→ `draft` when it has no done criteria yet, so the owner writes
 * them first) on the version it read (a concurrent write throws `ApiError`
 * 409), `log.md` records the move, and then the owner session wakes. Its turn
 * end (`kortix goals check --enforce`) arms the heartbeat the stop removed.
 * The wake id names the stop, so a retry is deduped. A retry after the wake
 * failed (the goal is open again, but no live heartbeat wakes it) writes
 * nothing and only wakes the owner. Throws on any other goal.
 */
export async function restartProjectGoal(
  projectId: string,
  goal: Pick<ProjectGoal, 'driveId' | 'folder' | 'heartbeat' | 'scope' | 'slug' | 'coordinatorSessionId'>,
  reason: string,
): Promise<ProjectGoalDocument> {
  const { doc: current, version } = await readGoalForWrite(goal);
  const heartbeatLive = !!goal.heartbeat?.session_id && goal.heartbeat.state !== 'done';
  const retry = !CLOSED.has(current.status) && !current.paused_at && !heartbeatLive;
  if (current.status !== 'stopped' && !retry) throw new Error(`The goal is ${current.status}, not stopped.`);
  const stoppedAt = [...current.transitions].reverse().find((t) => t.to === 'stopped')?.at ?? null;
  const to: ProjectGoalStatus = retry ? current.status : current.success_criteria.length ? 'active' : 'draft';
  let next = current;
  if (!retry) {
    const at = new Date().toISOString();
    next = { ...current, status: to, transitions: [...current.transitions, { from: 'stopped', to, at, reason, by: 'person' }] };
    await uploadDriveFile(goal.driveId, `${goal.folder}/GOAL.md`, new TextEncoder().encode(formatGoalFile(next)), { ifMatch: version });
    await appendGoalLog(goal, `- ${at} stopped → ${to}: ${reason}`);
  }
  const owner = ownerSessionId(current) ?? goal.coordinatorSessionId;
  if (owner) {
    const first =
      to === 'draft'
        ? 'A person started it again: write 1 to 8 done criteria someone else can check into GOAL.md, then move it to active and continue the work.'
        : 'A person started it again: read log.md for where it stopped and continue the work.';
    const wakeId = stoppedAt ? `goal-restart:${owner}:${stoppedAt}` : generateSessionId();
    await queueText(projectId, owner, `${goalWakePrompt(goalBoxFolder(goal))} ${first}`, wakeId);
  }
  return next;
}

/** The prompt every wake of a goal starts with; the API finds a goal's heartbeat by it. Same text as `kortix goals`. */
function goalWakePrompt(boxFolder: string): string {
  return `Goal wake: ${boxFolder}. Load the kortix-goals skill and run one wake.`;
}

/** A goal folder name from its outcome: lowercase words joined by `-`, at most 5. Same rule as `kortix goals new`. */
function goalSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-') || 'goal'
  );
}

const MAX_GOAL_CRITERIA = 8;
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

async function resolveGoalAgent(projectId: string, requested: string | null | undefined): Promise<string> {
  const { config } = await getProjectDetail(projectId);
  if (requested) {
    if (!goalAgents(config).some((a) => a.name === requested)) throw new Error(`${requested} cannot work a goal: it has no Files. Pick another agent.`);
    return requested;
  }
  const pick = defaultGoalAgent(config);
  if (!pick) throw new Error('This project has no agent that can work a goal. Add an agent, then try again.');
  return pick;
}

export interface CreateProjectGoalInput {
  /** What should be true when the goal is done, in the person's words. */
  outcome: string;
  /** Done criteria someone else can check: at most 8. Blank lines are dropped. None: the agent writes them. */
  criteria?: string[];
  /** The agent that works it (`assigned_agent`). It needs Files, so never My Kortix. Omitted: the project's default agent, else the first agent that can. */
  agent?: string | null;
  /** The person it is for: a user id. Omitted: nobody named in GOAL.md. */
  assignedUser?: string | null;
  /**
   * The owner session's id (an RFC 4122 v4 UUID). Pass the same id to retry a
   * create: a folder this session already owns is reused and nothing is written
   * twice. Omitted: a new id.
   */
  sessionId?: string;
  /** The creation time, UTC ISO 8601. Omitted: now. */
  now?: string;
}

export interface CreatedProjectGoal {
  slug: string;
  /** A goal a person creates from the app is theirs: it lives in their own folder. */
  scope: 'personal';
  driveId: string;
  folder: string;
  /** The owner session, already started on its first wake. */
  sessionId: string;
}

/**
 * A person creates a goal, in this order: the owner session (idle,
 * unattended), its heartbeat, `GOAL.md` (state `draft`, that session its
 * owner, the heartbeat recorded) and `log.md` in `<own folder>/Goals/<slug>/`,
 * then the session's first wake. Nothing runs before GOAL.md exists, so the
 * agent never races the write. The owner's turn end (`kortix goals check
 * --enforce`, run by kortixd) keeps the heartbeat alive because GOAL.md names
 * the session its owner: no step depends on the model remembering it.
 * A slug another goal holds gets `-2`, `-3`, …. Retrying with the same
 * `sessionId` is safe: a `409` session create is the session that already
 * exists, a folder it owns is reused, and the first wake is deduped.
 */
export async function createProjectGoal(projectId: string, input: CreateProjectGoalInput): Promise<CreatedProjectGoal> {
  const brief = input.outcome.trim();
  if (!brief) throw new Error('Describe the outcome.');
  // A brief (a template filled in) names the goal by its first line; the lines after it are the Context.
  const [firstLine = '', ...rest] = brief.split('\n');
  const outcome = firstLine.trim();
  const context = briefContext(rest) || "The request in the person's words, constraints, and what was learned.";
  const criteria = (input.criteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length > MAX_GOAL_CRITERIA) throw new Error(`A goal has at most ${MAX_GOAL_CRITERIA} done criteria.`);
  const agent = await resolveGoalAgent(projectId, input.agent);
  const drive = await getProjectDrive(projectId);
  if (!drive.personalFolder) throw new Error('Goals live in your personal folder in Files, and this project has none for you.');
  const sessionId = input.sessionId ?? generateSessionId();
  // A retry whose session already exists keeps that session's folder, even when the outcome was edited.
  const owned = await getProjectSession(projectId, sessionId, { showErrors: false }).then(
    (s) => /^\/drives\/me\/Goals\/([^/]+)$/.exec(String(s?.metadata?.goal ?? ''))?.[1] ?? null,
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    },
  );
  const base = owned ?? goalSlug(outcome);
  let slug = base;
  let reuse = false;
  for (let n = 2; ; n++) {
    const existing = await readText(drive.driveId, `${drive.personalFolder}/Goals/${slug}/GOAL.md`);
    if (existing === null) break;
    if (ownerSessionId(parseGoalFile(existing)) === sessionId) {
      reuse = true;
      break;
    }
    if (n > 50) throw new Error('Too many goals share this name. Reword the outcome.');
    slug = `${base}-${n}`;
  }
  const folder = `${drive.personalFolder}/Goals/${slug}`;
  const boxFolder = goalBoxFolder({ scope: 'personal', slug });
  // 1. The owner session, idle: nothing runs in it before GOAL.md exists.
  try {
    await createProjectSession(projectId, {
      session_id: sessionId,
      // Named after the outcome: a title generated from the wake prompt reads "Goal wake".
      name: outcome.slice(0, 120),
      agent_name: agent,
      metadata: { unattended: 'true', goal: boxFolder, goal_role: 'owner' },
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
  if (!reuse) {
    // 2. Its heartbeat, before GOAL.md: `transition active` needs exactly one, and GOAL.md records it.
    const { reminders } = await listSessionReminders(projectId, sessionId);
    const heartbeat =
      reminders.find((r) => r.state === 'active' && r.prompt.includes(boxFolder)) ??
      (await createSessionReminder(projectId, sessionId, { prompt: goalWakePrompt(boxFolder), in: '4h', every: '4h', name: `goal ${slug}` }));
    // 3. GOAL.md, written once, then log.md.
    const at = input.now ?? new Date().toISOString();
    const doc: ProjectGoalDocument = {
      version: 1,
      objective: outcome,
      status: 'draft',
      summary: '',
      assigned_user: input.assignedUser ?? null,
      agent,
      space: null,
      success_criteria: criteria.map((text, i) => ({ id: `c${i + 1}`, text, met: false, evidence: null })),
      items: [],
      links: [],
      waiting_on: null,
      heartbeat_every: '4h',
      max_wakes_per_day: 12,
      max_sessions: 10,
      sessions: [{ id: sessionId, role: 'owner', since: at }],
      reminder_id: heartbeat.id,
      next_wake_at: heartbeat.next_fire_at ?? null,
      verified_by: null,
      transitions: [{ from: null, to: 'draft', at, reason: 'goal created', by: 'person' }],
      body: `# ${outcome}\n\n## Context\n\n${context}\n`,
    };
    await uploadDriveFile(drive.driveId, `${folder}/GOAL.md`, new TextEncoder().encode(formatGoalFile(doc)));
    await uploadDriveFile(drive.driveId, `${folder}/log.md`, new TextEncoder().encode(`# Log\n\n- ${at} Goal created: ${outcome}\n`));
  } else if ((await readText(drive.driveId, `${folder}/log.md`)) === null) {
    // A retry after the log.md upload failed.
    const at = input.now ?? new Date().toISOString();
    await uploadDriveFile(drive.driveId, `${folder}/log.md`, new TextEncoder().encode(`# Log\n\n- ${at} Goal created: ${outcome}\n`));
  }
  // 4. The first wake. Its id is fixed per session, so a retry is deduped by the server.
  const first = criteria.length
    ? 'It is new: check the done criteria in GOAL.md, then move it to active and start the work.'
    : 'It is new: write 1 to 8 done criteria someone else can check into GOAL.md, then move it to active and start the work.';
  await queueText(projectId, sessionId, `${goalWakePrompt(boxFolder)} ${first}`, `goal-start:${sessionId}`);
  return { slug, scope: 'personal', driveId: drive.driveId, folder, sessionId };
}

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

async function queueText(projectId: string, sessionId: string, text: string, clientMessageId: string = generateSessionId()): Promise<void> {
  await createSessionPrompt(projectId, sessionId, {
    clientMessageId,
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
