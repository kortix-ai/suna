/**
 * `kortix goals` — outcomes an agent owns until they are verifiably done.
 *
 * A goal is a folder in Files (the `kortix-goals` skill): `goal.json` holds the
 * state, `log.md` the timeline, `docs/` and `evidence/` the files. The folder is
 * the source of truth; sessions are replaceable. These commands run inside a
 * session, where Files is mounted at /drives. `new` sets a goal up so its
 * invariants do not depend on the model remembering the skill, and `check`
 * verifies them; `check --enforce` is the session's on-idle hook (kortixd runs
 * ~/.kortix/hooks/on-idle after every turn end).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { boxFeatureFlags } from '../feature-flags.ts';
import { C, help, pad, status } from '../style.ts';
import { queueSessionPrompt } from './sessions-queue.ts';

const HELP = help`Usage: kortix goals <subcommand> [options]

A goal is an outcome an agent owns until it is verifiably done: a folder in
Files with goal.json (the state), log.md, notes.md, docs/ and evidence/. Run
these inside a session (Files is mounted at /drives). The kortix-goals skill
describes the whole loop.

Subcommands:
  new "<objective>"   Create the goal folder, mark this session unattended,
                      arm the daily heartbeat and install the on-idle check.
                      Prints the folder.
  transition <to> [<folder>] --reason "<why>"
                      Move the goal to another state. The only way status
                      changes: the edge must exist and its guard must hold
                      (draft→active needs 2-6 criteria and one heartbeat;
                      →waiting_on_user an open ask with owner and due;
                      →verifying every criterion met with evidence and a
                      verifier started; verifying→done an independent PASS).
                      done/abandoned also remove the heartbeat.
  check [<folder>]    Check every goal this session coordinates (or one
                      folder): goal.json is valid, an open goal has an active
                      heartbeat, done has an independent PASS in
                      evidence/verification.md, a closed goal has no heartbeat.
                      Exit 1 on a violation.
  ls                  List every goal in the mounted folders.
  status [<slug>]     One goal: status, summary, criteria, open asks, next wake.

Options:
  --slug <slug>       new: the folder name (default: from the objective).
  --shared            new: create it in /drives/company (the project) instead of
                      /drives/me (only you).
  --enforce           check: on a violation, queue a prompt to this session that
                      names it (at most 3 per goal in 6 hours). The on-idle hook
                      runs this.
  --quiet             check: print nothing when every goal passes.
  --json              Machine-readable output.
  -h, --help          Show this help.
`;

export const GOAL_STATUSES = ['draft', 'active', 'waiting_on_user', 'waiting_external', 'verifying', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
const OPEN = new Set<string>(['draft', 'active', 'waiting_on_user', 'waiting_external', 'verifying']);

/**
 * The goal state machine. A status changes only through `kortix goals
 * transition`, which allows the edges below and checks each edge's guard
 * (`transitionViolations`). Every open state may also go to `abandoned`.
 */
export const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ['active'],
  active: ['waiting_on_user', 'waiting_external', 'verifying'],
  waiting_on_user: ['active'],
  waiting_external: ['active'],
  verifying: ['done', 'active'],
  done: [],
  abandoned: [],
};
const ITEM_KINDS = new Set(['task', 'ask', 'wait']);
const ITEM_STATUSES = new Set(['open', 'doing', 'done', 'dropped']);

export interface GoalItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  owner?: string;
  due?: string | null;
}

/**
 * goal.json holds only what code reads (check, transition, ls, status).
 * Everything else the agent keeps in notes.md: constraints, people's threads,
 * what it learned. `check` reports any other key.
 */
export interface Goal {
  version: number;
  objective: string;
  status: string;
  summary?: string;
  success_criteria: Array<{ id: string; text: string; met: boolean; evidence: string | null }>;
  items: GoalItem[];
  sessions: Array<{ id: string; role: string; since?: string }>;
  reminder_id: string | null;
  /** Every status change, oldest first; the last `to` is the current status. */
  transitions?: Array<{ from: string | null; to: string; at: string; reason: string; by: string }>;
  verified_by?: string | null;
  next_wake_at?: string | null;
}

const GOAL_KEYS = new Set(['version', 'objective', 'status', 'summary', 'success_criteria', 'items', 'sessions', 'reminder_id', 'transitions', 'verified_by', 'next_wake_at']);
const ITEM_KEYS = new Set(['id', 'kind', 'title', 'status', 'owner', 'due']);

/** What `check` sees about one goal besides goal.json. */
export interface GoalFacts {
  /** Active reminder ids on the coordinating session that name this goal. */
  activeHeartbeats: string[];
  /** The coordinating session's metadata says unattended. */
  unattended: boolean;
  /** evidence/verification.md, or null when it does not exist. */
  verification: string | null;
}

/** Every broken invariant of one goal, as sentences the agent can act on. Empty: the goal is sound. */
export function goalViolations(raw: unknown, facts: GoalFacts): string[] {
  if (!raw || typeof raw !== 'object') return ['goal.json is not a JSON object.'];
  const g = raw as Partial<Goal>;
  const out: string[] = [];
  if (g.version !== 1) out.push('goal.json "version" must be 1.');
  if (typeof g.objective !== 'string' || !g.objective.trim()) out.push('goal.json has no "objective".');
  if (!GOAL_STATUSES.includes(g.status as never)) out.push(`goal.json "status" must be one of ${GOAL_STATUSES.join(', ')}.`);
  if (g.status !== 'draft' && (!Array.isArray(g.success_criteria) || g.success_criteria.length === 0)) {
    out.push('goal.json has no "success_criteria": write 2 to 6 checkable criteria.');
  }
  const last = g.transitions?.at(-1);
  if (GOAL_STATUSES.includes(g.status as never) && last && last.to !== g.status) {
    out.push(`"status" is ${g.status} but the last transition went to ${last.to}: status was edited by hand. Set it back and use kortix goals transition <to> --reason "…".`);
  }
  if (!Array.isArray(g.items)) out.push('goal.json "items" must be a list.');
  else {
    for (const item of g.items) {
      if (!ITEM_KINDS.has(item?.kind)) out.push(`item ${item?.id ?? '?'}: "kind" must be task, ask or wait.`);
      if (!ITEM_STATUSES.has(item?.status)) out.push(`item ${item?.id ?? '?'}: "status" must be open, doing, done or dropped.`);
      const extra = Object.keys(item ?? {}).filter((k) => !ITEM_KEYS.has(k));
      if (extra.length) out.push(`item ${item?.id ?? '?'}: unknown field(s) ${extra.join(', ')}; keep notes in notes.md.`);
    }
  }
  const unknown = Object.keys(g).filter((k) => !GOAL_KEYS.has(k));
  if (unknown.length) out.push(`goal.json has unknown field(s) ${unknown.join(', ')}; keep them in notes.md.`);
  const coordinators = (g.sessions ?? []).filter((s) => s.role === 'coordinator').map((s) => s.id);
  if (OPEN.has(g.status as string)) {
    if (facts.activeHeartbeats.length === 0) {
      out.push('The goal is open and no heartbeat reminder is active on this session: arm one (kortix remind "Goal wake: <folder>. Load the kortix-goals skill and run one wake." --in 24h --every 1d) and store its id in "reminder_id".');
    } else if (g.reminder_id && !facts.activeHeartbeats.includes(g.reminder_id)) {
      out.push(`"reminder_id" ${g.reminder_id} is not an active reminder; set it to ${facts.activeHeartbeats[0]}.`);
    } else if (facts.activeHeartbeats.length > 1) {
      out.push(`${facts.activeHeartbeats.length} heartbeat reminders are active for this goal; keep one (kortix reminders rm <id>).`);
    }
    if (!facts.unattended) out.push('This session is not marked unattended: run kortix sessions update --meta unattended=true.');
  }
  if (g.status === 'done') {
    const v = facts.verification;
    if (v === null) out.push('"status" is done but evidence/verification.md does not exist: start a verifier session (kortix-goals skill, <done>).');
    else if (!/\bPASS\b/.test(v) || /\bFAIL\b/.test(v)) out.push('"status" is done but evidence/verification.md is not PASS on every criterion.');
    if (!g.verified_by) out.push('"status" is done but "verified_by" is empty: set it to the verifier session id.');
    else if (coordinators.includes(g.verified_by)) out.push('"verified_by" is a coordinator: only a session that did none of the work may verify.');
  }
  if ((g.status === 'done' || g.status === 'abandoned') && facts.activeHeartbeats.length > 0) {
    out.push(`The goal is closed and its heartbeat ${facts.activeHeartbeats.join(', ')} is still active: kortix reminders rm <id>.`);
  }
  return out;
}

/** What a transition's guard sees besides goal.json. */
export interface TransitionFacts extends GoalFacts {
  /** Evidence paths (relative to the goal folder) that exist. */
  existingEvidence: Set<string>;
}

/** Why `from → to` is not allowed now. Empty: the transition may happen. */
export function transitionViolations(raw: unknown, to: string, reason: string, facts: TransitionFacts): string[] {
  const g = (raw ?? {}) as Partial<Goal>;
  const from = g.status as GoalStatus;
  if (!GOAL_STATUSES.includes(to as never)) return [`"${to}" is not a goal status: ${GOAL_STATUSES.join(', ')}.`];
  if (!reason.trim()) return ['Pass --reason "<why>": every transition is logged.'];
  if (to === 'abandoned') {
    return OPEN.has(from) ? [] : [`A ${from} goal cannot be abandoned.`];
  }
  if (!(TRANSITIONS[from] ?? []).includes(to as GoalStatus)) {
    return [`${from} → ${to} is not a transition. From ${from}: ${[...(TRANSITIONS[from] ?? []), ...(OPEN.has(from) ? ['abandoned'] : [])].join(', ') || 'none (closed)'}.`];
  }
  const out: string[] = [];
  const criteria = g.success_criteria ?? [];
  const items = g.items ?? [];
  const coordinators = (g.sessions ?? []).filter((s) => s.role === 'coordinator').map((s) => s.id);
  if (to === 'active' && from === 'draft') {
    if (criteria.length < 2 || criteria.length > 6) out.push(`Write 2 to 6 success_criteria (now ${criteria.length}).`);
    if (facts.activeHeartbeats.length !== 1) out.push(`Exactly one heartbeat must be active (now ${facts.activeHeartbeats.length}).`);
    if (!facts.unattended) out.push('Mark the session unattended: kortix sessions update --meta unattended=true.');
  }
  if (to === 'waiting_on_user') {
    const asks = items.filter((i) => i.kind === 'ask' && i.status === 'open');
    if (!asks.length) out.push('No open "ask" item: write what you need and from whom first.');
    for (const a of asks) if (!a.owner || !a.due) out.push(`ask ${a.id} needs an "owner" and a "due" time.`);
  }
  if (to === 'waiting_external') {
    const waits = items.filter((i) => i.kind === 'wait' && i.status === 'open');
    if (!waits.length) out.push('No open "wait" item: write what you wait for and until when first.');
    for (const w of waits) if (!w.due) out.push(`wait ${w.id} needs a "due" time.`);
  }
  if (to === 'verifying') {
    for (const c of criteria) {
      if (!c.met) out.push(`Criterion ${c.id} is not met.`);
      else if (!c.evidence || !facts.existingEvidence.has(c.evidence.split(' ')[0]!)) out.push(`Criterion ${c.id} has no existing evidence file.`);
    }
    if (!(g.sessions ?? []).some((s) => s.role === 'verifier')) out.push('Start a verifier session and record it in "sessions" with role "verifier" first.');
  }
  if (to === 'done') {
    const v = facts.verification;
    if (v === null || !/\bPASS\b/.test(v) || /\bFAIL\b/.test(v)) out.push('evidence/verification.md must say PASS on every criterion.');
    if (!g.verified_by || coordinators.includes(g.verified_by) || !(g.sessions ?? []).some((s) => s.id === g.verified_by && s.role === 'verifier')) {
      out.push('"verified_by" must be the id of a verifier session listed in "sessions".');
    }
  }
  return out;
}

/**
 * The goal flags that are off. In a box the flags come from KORTIX_FEATURE_FLAGS,
 * so a session without repository access needs no API read. That list is set at
 * boot: when it says off, the API's current answer wins if it can be read.
 */
async function goalFlagsOff(client: ApiClient, projectId: string): Promise<string[]> {
  const box = boxFeatureFlags();
  const fromBox = box ? missingGoalFlags(Object.fromEntries([...box].map((f) => [f, true]))) : null;
  if (fromBox?.length === 0) return [];
  try {
    return missingGoalFlags((await client.get<{ experimental?: Record<string, boolean> }>(`/projects/${projectId}`)).experimental);
  } catch (err) {
    if (fromBox) return fromBox;
    throw err;
  }
}

/** The project features a goal needs that are off. */
export function missingGoalFlags(experimental: Record<string, boolean> | undefined): string[] {
  return ['goals', 'volumes', 'reminders'].filter((k) => !experimental?.[k]);
}

const drivesRoot = () => process.env.KORTIX_DRIVES_ROOT ?? '/drives';

/** Every goal folder under the mounted drives: /drives/<mount>/Goals/<slug>. */
export function goalFolders(root = drivesRoot()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const mount of readdirSync(root, { withFileTypes: true })) {
    if (!mount.isDirectory()) continue;
    const goals = join(root, mount.name, 'Goals');
    if (!existsSync(goals)) continue;
    for (const g of readdirSync(goals, { withFileTypes: true })) {
      if (g.isDirectory() && existsSync(join(goals, g.name, 'goal.json'))) out.push(join(goals, g.name));
    }
  }
  return out.sort();
}

function readGoal(folder: string): unknown {
  try {
    return JSON.parse(readFileSync(join(folder, 'goal.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function slugify(text: string): string {
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

interface Reminder {
  id: string;
  prompt: string;
  state: string;
}

const heartbeatPrompt = (folder: string) => `Goal wake: ${folder}. Load the kortix-goals skill and run one wake.`;

const ON_IDLE_HOOK = () => join(homedir(), '.kortix', 'hooks', 'on-idle');
const ENFORCE_STATE = () => join(homedir(), '.kortix', 'state', 'goal-check.json');
const ENFORCE_MAX = 3;
const ENFORCE_WINDOW_MS = 6 * 60 * 60_000;

/** Records one enforcement prompt for `folder`; false when the cap for the window is used up. */
export function takeEnforcementSlot(folder: string, now: number, path = ENFORCE_STATE()): boolean {
  let state: Record<string, number[]> = {};
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  const recent = (state[folder] ?? []).filter((t) => now - t < ENFORCE_WINDOW_MS);
  if (recent.length >= ENFORCE_MAX) return false;
  state[folder] = [...recent, now];
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
  return true;
}

function installOnIdleHook(): void {
  const path = ON_IDLE_HOOK();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n# Installed by `kortix goals new`: check every goal this session coordinates.\nexec kortix goals check --enforce --quiet\n');
  chmodSync(path, 0o755);
}

export async function runGoals(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  let slugFlag: string | undefined;
  let shared = false;
  let enforce = false;
  let quiet = false;
  let json = false;
  try {
    slugFlag = takeFlagValue(rest, ['--slug']);
    shared = takeFlagBool(rest, ['--shared']);
    enforce = takeFlagBool(rest, ['--enforce']);
    quiet = takeFlagBool(rest, ['--quiet']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sub = rest.shift();
  let reason = '';
  try {
    reason = takeFlagValue(rest, ['--reason']) ?? '';
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!sub || !['new', 'check', 'transition', 'ls', 'list', 'status'].includes(sub)) {
    return fail(`Unknown subcommand "${sub ?? ''}". Run \`kortix goals --help\`.`);
  }
  if (sub !== 'new' && !existsSync(drivesRoot())) {
    return fail('Files is not mounted here (no /drives). Run kortix goals inside a session of a project with Volumes on.');
  }
  if (sub === 'ls' || sub === 'list') return listGoals(json);
  if (sub === 'status') return goalStatus(rest[0], json);

  const sessionId = process.env.KORTIX_SESSION_ID;
  if (!sessionId) return fail('No $KORTIX_SESSION_ID: kortix goals new/check run inside a session.');
  const ctx = await resolveProjectContext({});
  if (!ctx) return 1;
  const { client, projectId } = ctx;
  const sessionPath = `/projects/${projectId}/sessions/${sessionId}`;

  try {
    if (sub === 'new') {
      const objective = rest.join(' ').trim();
      if (!objective) return missing('the objective, e.g. kortix goals new "Rho business account fully closed"');
      const off = await goalFlagsOff(client, projectId);
      if (off.length) {
        return fail(`Goals need these project features on: ${off.join(', ')}. Turn them on with ${off.map((f) => `kortix projects features enable ${f}`).join(' && ')} (a project admin), then run this again.`);
      }
      if (!existsSync(drivesRoot())) return fail('Files is not mounted in this session yet. Volumes is on: start a new session, then run this again.');
      const mount = join(drivesRoot(), shared ? 'company' : 'me');
      if (!existsSync(mount)) return fail(`${mount} is not mounted in this session; see /drives/README.md.`);
      const slug = slugFlag ?? slugify(objective);
      const folder = join(mount, 'Goals', slug);
      if (existsSync(join(folder, 'goal.json'))) return fail(`${folder} already holds a goal. Pick another --slug.`);
      mkdirSync(join(folder, 'docs'), { recursive: true });
      mkdirSync(join(folder, 'evidence'), { recursive: true });
      await client.patch(sessionPath, { metadata: { unattended: 'true' } });
      const reminder = await client.post<Reminder & { next_fire_at: string | null }>(`${sessionPath}/reminders`, {
        prompt: heartbeatPrompt(folder),
        in: '24h',
        every: '1d',
        name: `goal ${slug}`,
      });
      const now = new Date().toISOString();
      const goal: Goal = {
        version: 1,
        objective,
        status: 'draft',
        summary: '',
        success_criteria: [],
        items: [],
        sessions: [{ id: sessionId, role: 'coordinator', since: now }],
        reminder_id: reminder.id,
        verified_by: null,
        next_wake_at: reminder.next_fire_at,
        transitions: [{ from: null, to: 'draft', at: now, reason: 'goal created', by: sessionId }],
      };
      writeFileSync(join(folder, 'goal.json'), `${JSON.stringify(goal, null, 2)}\n`);
      writeFileSync(join(folder, 'log.md'), `# Log\n\n- ${now} Goal created: ${objective}\n`);
      writeFileSync(join(folder, 'notes.md'), `# Notes\n\n## Request\n\n${objective}\n\n## Constraints\n\n## Threads\n\nOne bound thread per person: person, channel, thread.\n\n## Learned\n`);
      installOnIdleHook();
      if (json) emitJson({ folder, slug, reminder_id: reminder.id, next_wake_at: reminder.next_fire_at });
      else {
        process.stdout.write(`${status.ok(`Goal created: ${C.bold}${folder}${C.reset}`)}\n`);
        process.stdout.write(`  ${C.dim}heartbeat ${C.reset}${reminder.id} (daily, next ${reminder.next_fire_at ?? '—'})\n`);
        process.stdout.write(`  ${C.dim}next      ${C.reset}write success_criteria into goal.json, then kortix goals transition active --reason "…"\n`);
      }
      return 0;
    }

    if (sub === 'transition') return await transitionGoal(client, sessionPath, sessionId, rest[0], rest[1], reason, json);

    // check
    const folders = rest[0] ? [rest[0]] : goalFolders().filter((f) => {
      const g = readGoal(f) as Partial<Goal> | null;
      return g?.sessions?.some((s) => s.id === sessionId && s.role === 'coordinator') ?? false;
    });
    const [{ reminders }, session] = await Promise.all([
      client.get<{ reminders: Reminder[] }>(`${sessionPath}/reminders`),
      client.get<ProjectSession & { metadata?: Record<string, unknown> }>(sessionPath),
    ]);
    const unattended = ['true', true].includes(session.metadata?.unattended as never);
    const results = folders.map((folder) => {
      const raw = readGoal(folder);
      const g = raw as Partial<Goal> | null;
      const activeHeartbeats = reminders
        .filter((r) => r.state === 'active' && (r.id === g?.reminder_id || r.prompt.includes(folder)))
        .map((r) => r.id);
      const vPath = join(folder, 'evidence', 'verification.md');
      const verification = existsSync(vPath) ? readFileSync(vPath, 'utf8') : null;
      return { folder, violations: raw === null ? ['goal.json is missing or not valid JSON.'] : goalViolations(raw, { activeHeartbeats, unattended, verification }) };
    });
    const broken = results.filter((r) => r.violations.length > 0);
    if (json) emitJson({ goals: results });
    else if (!(quiet && broken.length === 0)) {
      for (const r of results) {
        process.stdout.write(r.violations.length ? `${status.err(r.folder)}\n${r.violations.map((v) => `  - ${v}`).join('\n')}\n` : `${status.ok(r.folder)}\n`);
      }
    }
    if (enforce) await enforceGoals(client, projectId, session, broken);
    return broken.length ? 1 : 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

/** The goals this session coordinates. */
function coordinatedGoals(sessionId: string): string[] {
  return goalFolders().filter((f) => {
    const g = readGoal(f) as Partial<Goal> | null;
    return g?.sessions?.some((s) => s.id === sessionId && s.role === 'coordinator') ?? false;
  });
}

async function transitionGoal(
  client: ApiClient,
  sessionPath: string,
  sessionId: string,
  to: string | undefined,
  folderArg: string | undefined,
  reason: string,
  json: boolean,
): Promise<number> {
  if (!to) return missing('the target status: kortix goals transition <to> --reason "…" [<folder>]');
  const mine = coordinatedGoals(sessionId);
  const folder = folderArg ?? (mine.length === 1 ? mine[0] : undefined);
  if (!folder) return fail(mine.length ? 'This session coordinates several goals: pass the folder.' : 'No goal is coordinated by this session: pass the folder.');
  const raw = readGoal(folder);
  if (raw === null) return fail(`${folder}/goal.json is missing or not valid JSON.`);
  const g = raw as Goal;
  const [{ reminders }, session] = await Promise.all([
    client.get<{ reminders: Reminder[] }>(`${sessionPath}/reminders`),
    client.get<ProjectSession & { metadata?: Record<string, unknown> }>(sessionPath),
  ]);
  const heartbeats = reminders.filter((r) => r.state === 'active' && (r.id === g.reminder_id || r.prompt.includes(folder)));
  const vPath = join(folder, 'evidence', 'verification.md');
  const existingEvidence = new Set(
    (g.success_criteria ?? []).map((c) => c.evidence?.split(' ')[0]).filter((p): p is string => !!p && existsSync(join(folder, p))),
  );
  const violations = transitionViolations(raw, to, reason, {
    activeHeartbeats: heartbeats.map((r) => r.id),
    unattended: ['true', true].includes(session.metadata?.unattended as never),
    verification: existsSync(vPath) ? readFileSync(vPath, 'utf8') : null,
    existingEvidence,
  });
  if (violations.length) {
    if (json) emitJson({ ok: false, from: g.status, to, violations });
    else process.stderr.write(`${status.err(`${g.status} → ${to} refused`)}\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
    return 1;
  }
  // A closed goal wakes no one: its heartbeat goes with the transition.
  if (to === 'done' || to === 'abandoned') {
    for (const r of heartbeats) await client.delete(`${sessionPath}/reminders/${r.id}`);
  }
  const now = new Date().toISOString();
  const next: Goal = {
    ...g,
    status: to,
    ...(to === 'done' || to === 'abandoned' ? { reminder_id: null, next_wake_at: null } : {}),
    transitions: [...(g.transitions ?? []), { from: g.status, to, at: now, reason, by: sessionId }],
  };
  writeFileSync(join(folder, 'goal.json'), `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(join(folder, 'log.md'), `${readFileSync(join(folder, 'log.md'), 'utf8').trimEnd()}\n- ${now} ${g.status} → ${to}: ${reason}\n`);
  if (json) emitJson({ ok: true, from: g.status, to });
  else process.stdout.write(`${status.ok(`${g.status} → ${to}`)}\n`);
  return 0;
}

async function enforceGoals(
  client: ApiClient,
  projectId: string,
  session: ProjectSession,
  broken: Array<{ folder: string; violations: string[] }>,
): Promise<void> {
  const due = broken.filter((b) => takeEnforcementSlot(b.folder, Date.now()));
  if (!due.length) return;
  const text =
    '[GOAL CHECK] The goal invariants failed after your last turn. Fix them now, then end the turn:\n' +
    due.map((b) => `${b.folder}\n${b.violations.map((v) => `- ${v}`).join('\n')}`).join('\n\n');
  await queueSessionPrompt(client, projectId, session, text);
}

function summarize(folder: string) {
  const g = readGoal(folder) as Partial<Goal> | null;
  const criteria = g?.success_criteria ?? [];
  const asks = (g?.items ?? []).filter((i) => i.kind === 'ask' && i.status === 'open');
  return {
    folder,
    slug: folder.split('/').pop()!,
    status: g?.status ?? 'invalid',
    objective: g?.objective ?? '',
    summary: g?.summary ?? '',
    criteria_met: criteria.filter((c) => c.met).length,
    criteria_total: criteria.length,
    open_asks: asks.map((a) => ({ id: a.id, title: a.title, owner: a.owner ?? null, due: a.due ?? null })),
    next_wake_at: g?.next_wake_at ?? null,
  };
}

function listGoals(json: boolean): number {
  const goals = goalFolders().map(summarize);
  if (json) {
    emitJson({ goals });
    return 0;
  }
  if (!goals.length) {
    process.stdout.write(`  ${C.dim}No goals in the mounted folders. Start one: kortix goals new "<objective>"${C.reset}\n`);
    return 0;
  }
  const w = Math.max(...goals.map((g) => g.slug.length), 4);
  process.stdout.write(`\n  ${C.dim}${pad('GOAL', w)}  ${pad('STATUS', 16)}  CRITERIA  ASKS  NEXT WAKE${C.reset}\n`);
  for (const g of goals) {
    process.stdout.write(`  ${pad(g.slug, w)}  ${pad(g.status, 16)}  ${pad(`${g.criteria_met}/${g.criteria_total}`, 8)}  ${pad(String(g.open_asks.length), 4)}  ${g.next_wake_at ?? '—'}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function goalStatus(slug: string | undefined, json: boolean): number {
  const folders = goalFolders();
  const folder = slug ? folders.find((f) => f.endsWith(`/${slug}`)) : folders.length === 1 ? folders[0] : undefined;
  if (!folder) return fail(slug ? `No goal "${slug}" in the mounted folders.` : 'Name the goal: kortix goals status <slug> (kortix goals ls lists them).');
  const s = summarize(folder);
  if (json) {
    emitJson(s);
    return 0;
  }
  process.stdout.write(`\n  ${C.bold}${s.objective}${C.reset}\n  ${C.dim}${s.folder}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}status   ${C.reset}${s.status}\n  ${C.dim}criteria ${C.reset}${s.criteria_met}/${s.criteria_total} met\n  ${C.dim}next     ${C.reset}${s.next_wake_at ?? '—'}\n`);
  if (s.summary) process.stdout.write(`\n  ${s.summary}\n`);
  if (s.open_asks.length) {
    process.stdout.write(`\n  ${C.dim}Waiting on people:${C.reset}\n`);
    for (const a of s.open_asks) process.stdout.write(`  - ${a.title}${a.owner ? ` (${a.owner})` : ''}${a.due ? `, due ${a.due}` : ''}\n`);
  }
  process.stdout.write('\n');
  return 0;
}
