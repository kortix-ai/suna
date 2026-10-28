/**
 * `kortix goals` — what a person wants plus a definition of done, worked by an
 * assigned agent until an independent verifier session confirms it.
 *
 * A goal is a folder in Files, `Goals/<slug>/` in the company folder by
 * default (the `kortix-goals` skill): `GOAL.md` (front matter = definition and
 * state, `@kortix/sdk` parseGoalFile/formatGoalFile), `log.md` (append-only),
 * `evidence/`. The folder is the source of truth; sessions are replaceable.
 * These commands run inside a session, where Files is mounted at /drives.
 *
 * The rules are code, not prose (live runs: written rules failed 4 of 7):
 * - one owner session at a time moves the goal; `handover` starts the next one;
 * - only `verify` enters `verifying`, and it starts the verifier itself;
 * - only the current verifier, which did none of the work, sets `done` or
 *   sends the goal back to `active` (`verdict`);
 * - wakes per UTC day and sessions per goal are capped (`check --enforce`,
 *   `verify`, `handover`). kortixd runs `check --enforce` after every turn of
 *   an owner session (harness/shared/on-idle-hook.ts) and it repairs what it
 *   can by itself: the heartbeat, the cap, a closed goal's heartbeat.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatGoalFile, parseGoalFile, type ProjectGoalDocument, type ProjectGoalStatus } from '@kortix/sdk';
import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { boxFeatureFlags } from '../feature-flags.ts';
import { C, help, pad, status } from '../style.ts';
import { queueSessionPrompt } from './sessions-queue.ts';

const HELP = help`Usage: kortix goals <subcommand> [options]

A goal is what someone wants plus a definition of done. The assigned agent
works it, wake after wake, until an independent verifier session confirms it.
It is a folder in Files: Goals/<slug>/ with GOAL.md (definition and state),
log.md (append-only) and evidence/. Run these inside a session (Files is
mounted at /drives). The kortix-goals skill describes the whole loop.

Lifecycle: draft → active ⇄ waiting_on_user; active → verifying (verify) →
done (verifier PASS) or back to active (verifier FAIL); any → stopped.

Subcommands:
  new "<goal>"        Create Goals/<slug>/ in the company folder, make this
                      session its owner, mark it unattended and arm the
                      heartbeat. State: draft.
  transition <to> --reason "<why>" [<folder>]
                      Owner only. active (from draft: 1-8 done criteria),
                      waiting_on_user (the reason is the question for the
                      assigned user), active again, or stopped (a person said
                      stop). verifying and done are not reachable here.
  verify [<folder>]   Owner only. Every criterion met with an existing
                      evidence file: starts a fresh verifier session (no
                      memory of the work) and moves the goal to verifying.
  verdict pass|fail --reason "<why>" [<folder>]
                      Verifier only, after writing evidence/verification.md.
                      pass → done (the heartbeat goes); fail → active with
                      the findings in log.md. Wakes the owner.
  handover --note "<state of play>" [<folder>]
                      Owner only, when its context is full: writes the note
                      to log.md and starts a fresh owner session.
  check [<folder>]    Check the goals this session owns. With --enforce
                      (kortixd runs it after every owner turn): count the wake,
                      re-arm a missing heartbeat, hold the heartbeat until the
                      next UTC day at the wake cap, drop a closed goal's
                      heartbeat, and prompt the owner for what code cannot fix.
  bind [<slug>]       Group the goal under a space or an agent (--space,
                      --agent, --clear). Grouping only: it grants nothing.
  ls                  List every goal in the mounted folders.
  status [<slug>]     One goal: state, criteria, what it waits on, next wake.

Options:
  --slug <slug>       new: the folder name (default: from the goal).
  --folder <dir>      new: put Goals/<slug>/ under this folder of /drives
                      instead of /drives/company. Sharing stays Files sharing.
  --user <user_id>    new: the assigned user (default: this session's creator).
  --agent <name>      new: the assigned agent (default: $KORTIX_AGENT_NAME);
                      bind: the agent the goal is grouped under.
  --every <duration>  new: the heartbeat interval (default 4h, minimum 5m).
  --space <slug>      new, bind: the space the goal is grouped in.
  --clear             bind: remove the space and the agent.
  --enforce           check: repair and prompt (see check).
  --quiet             check: print nothing when every goal passes.
  --json              Machine-readable output.
  -h, --help          Show this help.

Limits (GOAL.md front matter, defaults in brackets): heartbeat [4h],
max_wakes_per_day [12], max_sessions [10].
`;

export const HEARTBEAT_EVERY = '4h';
export const MAX_WAKES_PER_DAY = 12;
export const MAX_SESSIONS = 10;
const OPEN = new Set<string>(['draft', 'active', 'waiting_on_user', 'verifying']);
/** The moves `transition` makes. verifying and done belong to verify and verdict. */
const TRANSITIONS: Record<string, readonly ProjectGoalStatus[]> = {
  draft: ['active'],
  active: ['waiting_on_user'],
  waiting_on_user: ['active'],
};
const SPACE_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** The session that works the goal now: the last owner (a legacy goal.json says coordinator). */
export function ownerOf(g: Pick<ProjectGoalDocument, 'sessions'> | null): string | null {
  return [...(g?.sessions ?? [])].reverse().find((s) => s.role === 'owner' || s.role === 'coordinator')?.id ?? null;
}

const owners = (g: ProjectGoalDocument) => g.sessions.filter((s) => s.role === 'owner' || s.role === 'coordinator').map((s) => s.id);
const passes = (report: string | null) => report !== null && /\bPASS\b/.test(report) && !/\bFAIL\b/.test(report);
const sessionCap = (g: ProjectGoalDocument) => g.max_sessions ?? MAX_SESSIONS;

/** Why `transition <to>` is refused now. Empty: allowed. */
export function transitionViolations(
  g: ProjectGoalDocument,
  to: string,
  reason: string,
  facts: { activeHeartbeats: string[]; unattended: boolean; sessionId: string },
): string[] {
  if (to === 'verifying') return ['Run kortix goals verify: it checks the evidence and starts the verifier.'];
  if (to === 'done') return ['Only the verifier ends a goal: kortix goals verdict pass, run in the verifier session.'];
  if (!reason.trim()) return ['Pass --reason "<why>": every move is logged.'];
  if (ownerOf(g) !== facts.sessionId) return [`Only the owner session ${ownerOf(g) ?? '(none)'} moves this goal.`];
  if (!OPEN.has(g.status)) return [`The goal is ${g.status} (closed): it has no moves.`];
  if (to === 'stopped') return [];
  if (!(TRANSITIONS[g.status] ?? []).includes(to as ProjectGoalStatus)) {
    return [`${g.status} → ${to} is not a move. From ${g.status}: ${[...(TRANSITIONS[g.status] ?? []), 'stopped'].join(', ')}.`];
  }
  const out: string[] = [];
  if (g.status === 'draft') {
    const n = g.success_criteria.length;
    if (n < 1 || n > 8) out.push(`Write 1 to 8 done_criteria in GOAL.md (now ${n}).`);
    if (facts.activeHeartbeats.length !== 1) out.push(`Exactly one heartbeat must be active (now ${facts.activeHeartbeats.length}).`);
    if (!facts.unattended) out.push('Mark the session unattended: kortix sessions update --meta unattended=true.');
  }
  return out;
}

/** Why `verify` is refused now. Empty: start the verifier. */
export function verifyViolations(g: ProjectGoalDocument, facts: { existingEvidence: Set<string>; sessionId: string }): string[] {
  if (ownerOf(g) !== facts.sessionId) return [`Only the owner session ${ownerOf(g) ?? '(none)'} asks for verification.`];
  if (g.status !== 'active') return [`The goal is ${g.status}; verify runs on an active goal.`];
  const out: string[] = [];
  if (g.success_criteria.length === 0) out.push('GOAL.md has no done_criteria.');
  for (const c of g.success_criteria) {
    if (!c.met) out.push(`Criterion ${c.id} is not met.`);
    else if (!c.evidence || !facts.existingEvidence.has(c.evidence)) out.push(`Criterion ${c.id} has no existing evidence file.`);
  }
  if (g.sessions.length >= sessionCap(g)) {
    out.push(`The goal used ${g.sessions.length} of max_sessions ${sessionCap(g)}: ask the assigned user to raise max_sessions in GOAL.md.`);
  }
  return out;
}

/** Why `verdict <pass|fail>` is refused now. Empty: record it. */
export function verdictViolations(
  g: ProjectGoalDocument,
  verdict: string,
  reason: string,
  facts: { sessionId: string; verification: string | null },
): string[] {
  if (verdict !== 'pass' && verdict !== 'fail') return ['The verdict is pass or fail.'];
  if (!reason.trim()) return ['Pass --reason "<why>": the owner reads it in log.md.'];
  if (g.status !== 'verifying') return [`The goal is ${g.status}, not verifying.`];
  const verifier = [...g.sessions].reverse().find((s) => s.role === 'verifier')?.id;
  if (verifier !== facts.sessionId) return [`Only the current verifier session ${verifier ?? '(none)'} gives the verdict.`];
  if (owners(g).includes(facts.sessionId)) return ['This session owned the goal: a session that did the work cannot verify it.'];
  if (facts.verification === null) return ['Write your report to evidence/verification.md first: PASS or FAIL per criterion, with the reason.'];
  if (verdict === 'pass' && !passes(facts.verification)) return ['evidence/verification.md must say PASS on every criterion and FAIL on none.'];
  return [];
}

/** Count one wake on `now`'s UTC day. `capped`: this wake reached max_wakes_per_day. */
export function recordWake(g: ProjectGoalDocument, now: Date): { doc: ProjectGoalDocument; capped: boolean } {
  const day = now.toISOString().slice(0, 10);
  const count = g.wake_day === day ? (g.wake_count ?? 0) + 1 : 1;
  return { doc: { ...g, wake_day: day, wake_count: count, last_wake_at: now.toISOString() }, capped: count >= (g.max_wakes_per_day ?? MAX_WAKES_PER_DAY) };
}

const nextUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

/** What the owner must fix by hand. Repairs `check --enforce` makes itself are not listed. */
export function goalViolations(g: ProjectGoalDocument | null, facts: { verification: string | null }): string[] {
  if (!g) return ['GOAL.md is missing or has no front matter with a "goal:" line.'];
  const out: string[] = [];
  const states = [...OPEN, 'done', 'stopped'];
  if (!states.includes(g.status)) out.push(`GOAL.md "state" must be one of ${states.join(', ')}.`);
  const last = g.transitions.at(-1);
  if (last && last.to !== g.status) {
    out.push(`"state" is ${g.status} but the last transition went to ${last.to}: it was edited by hand. Set it back to ${last.to}.`);
  }
  if (g.status === 'done') {
    if (!passes(facts.verification)) out.push('"state" is done but evidence/verification.md is not PASS on every criterion.');
    if (!g.verified_by || owners(g).includes(g.verified_by)) out.push('"verified_by" must be a verifier session, not an owner.');
  }
  if (g.space != null && !SPACE_SLUG.test(String(g.space))) out.push('"space" must be a space slug or null.');
  if (g.agent != null && !AGENT_NAME.test(String(g.agent))) out.push('"assigned_agent" must be an agent name or null.');
  return out;
}

/** The goal flags that are off. In a box they come from KORTIX_FEATURE_FLAGS; off there, the API's answer wins. */
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

/** Every goal folder under the mounted drives: /drives/<mount>/Goals/<slug> with GOAL.md (or a legacy goal.json). */
export function goalFolders(root = drivesRoot()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const mount of readdirSync(root, { withFileTypes: true })) {
    if (!mount.isDirectory()) continue;
    const goals = join(root, mount.name, 'Goals');
    if (!existsSync(goals)) continue;
    for (const g of readdirSync(goals, { withFileTypes: true })) {
      const dir = join(goals, g.name);
      if (g.isDirectory() && (existsSync(join(dir, 'GOAL.md')) || existsSync(join(dir, 'goal.json')))) out.push(dir);
    }
  }
  return out.sort();
}

function readGoal(folder: string): ProjectGoalDocument | null {
  try {
    if (existsSync(join(folder, 'GOAL.md'))) return parseGoalFile(readFileSync(join(folder, 'GOAL.md'), 'utf8'));
    const legacy = JSON.parse(readFileSync(join(folder, 'goal.json'), 'utf8')) as ProjectGoalDocument;
    return { ...legacy, success_criteria: legacy.success_criteria ?? [], sessions: legacy.sessions ?? [], transitions: legacy.transitions ?? [], format: 'goal.json' };
  } catch {
    return null;
  }
}

const writeGoal = (folder: string, g: ProjectGoalDocument) => writeFileSync(join(folder, 'GOAL.md'), formatGoalFile(g));
const readReport = (folder: string) => {
  const path = join(folder, 'evidence', 'verification.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

function appendLog(folder: string, line: string): void {
  const path = join(folder, 'log.md');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '# Log\n';
  writeFileSync(path, `${current.trimEnd()}\n${line}\n`);
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
  next_fire_at?: string | null;
}

export const heartbeatPrompt = (folder: string) => `Goal wake: ${folder}. Load the kortix-goals skill and run one wake.`;
const verifierPrompt = (folder: string) =>
  `Verify the goal in ${folder}. Load the kortix-goals skill (<verify>). You did none of the work and have no memory of it. ` +
  'Check every done criterion in GOAL.md yourself, against its evidence and the real world. Write PASS or FAIL per criterion, ' +
  'with the reason, to evidence/verification.md. Then run kortix goals verdict pass|fail --reason "…". Do not edit GOAL.md.';
const ownerPrompt = (folder: string, from: string) =>
  `${heartbeatPrompt(folder)} You are its new owner: session ${from} handed it over because its context was full. ` +
  'Read GOAL.md and the handover at the end of log.md first.';

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

interface Ctx {
  client: ApiClient;
  projectId: string;
  sessionId: string;
  sessionPath: string;
}

interface Flags {
  slug?: string;
  folder?: string;
  user?: string;
  agent?: string;
  every?: string;
  space?: string;
  note?: string;
  reason: string;
  clear: boolean;
  enforce: boolean;
  quiet: boolean;
  json: boolean;
}

function parseFlags(rest: string[]): Flags {
  // --shared meant "in the company folder": that is the default now.
  takeFlagBool(rest, ['--shared']);
  return {
    slug: takeFlagValue(rest, ['--slug']),
    folder: takeFlagValue(rest, ['--folder']),
    user: takeFlagValue(rest, ['--user']),
    agent: takeFlagValue(rest, ['--agent']),
    every: takeFlagValue(rest, ['--every']),
    space: takeFlagValue(rest, ['--space']),
    note: takeFlagValue(rest, ['--note']),
    reason: takeFlagValue(rest, ['--reason']) ?? '',
    clear: takeFlagBool(rest, ['--clear']),
    enforce: takeFlagBool(rest, ['--enforce']),
    quiet: takeFlagBool(rest, ['--quiet']),
    json: takeFlagBool(rest, ['--json']),
  };
}

const SUBCOMMANDS = ['new', 'check', 'transition', 'verify', 'verdict', 'handover', 'bind', 'ls', 'list', 'status'];

export async function runGoals(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sub = rest.shift();
  if (flags.space !== undefined && !SPACE_SLUG.test(flags.space)) return fail(`--space "${flags.space}" is not a space slug.`);
  if (flags.agent !== undefined && !AGENT_NAME.test(flags.agent)) return fail(`--agent "${flags.agent}" is not an agent name.`);
  if (!sub || !SUBCOMMANDS.includes(sub)) return fail(`Unknown subcommand "${sub ?? ''}". Run \`kortix goals --help\`.`);
  if (sub !== 'new' && !existsSync(drivesRoot())) {
    return fail('Files is not mounted here (no /drives). Run kortix goals inside a session of a project with Volumes on.');
  }
  if (sub === 'ls' || sub === 'list') return listGoals(flags.json);
  if (sub === 'status') return goalStatus(rest[0], flags.json);
  if (sub === 'bind') return bindGoal(rest[0], flags);

  const sessionId = process.env.KORTIX_SESSION_ID;
  if (!sessionId) return fail('No $KORTIX_SESSION_ID: kortix goals runs inside a session.');
  const resolved = await resolveProjectContext({});
  if (!resolved) return 1;
  const ctx: Ctx = { ...resolved, sessionId, sessionPath: `/projects/${resolved.projectId}/sessions/${sessionId}` };
  try {
    if (sub === 'new') return await newGoal(ctx, rest.join(' ').trim(), flags);
    if (sub === 'check') return await checkGoals(ctx, rest[0], flags);
    if (sub === 'verdict') return await verdictGoal(ctx, rest[0], rest[1], flags);
    const folder = pickFolder(sub === 'transition' ? rest[1] : rest[0], sessionId);
    if (!folder) return fail('Pass the goal folder: this session owns none, or several.');
    const g = readGoal(folder);
    if (!g) return fail(`${folder}/GOAL.md is missing or unreadable.`);
    if (sub === 'transition') return await transitionGoal(ctx, folder, g, rest[0] ?? '', flags);
    if (sub === 'verify') return await verifyGoal(ctx, folder, g, flags);
    return await handoverGoal(ctx, folder, g, flags);
  } catch (err) {
    return surfaceApiError(err);
  }
}

/** `<folder>` when given, else the one goal this session owns. */
function pickFolder(arg: string | undefined, sessionId: string): string | undefined {
  if (arg && arg.startsWith('/')) return arg;
  const mine = goalFolders().filter((f) => ownerOf(readGoal(f)) === sessionId);
  return mine.length === 1 ? mine[0] : undefined;
}

async function armHeartbeat(ctx: Ctx, folder: string, g: ProjectGoalDocument, at?: string): Promise<Reminder> {
  const every = g.heartbeat_every ?? HEARTBEAT_EVERY;
  return ctx.client.post<Reminder>(`${ctx.sessionPath}/reminders`, {
    prompt: heartbeatPrompt(folder),
    ...(at ? { at } : { in: every }),
    every,
    name: `goal ${folder.split('/').at(-1)}`,
  });
}

async function heartbeatsOf(ctx: Ctx, folder: string, g: ProjectGoalDocument): Promise<Reminder[]> {
  const { reminders } = await ctx.client.get<{ reminders: Reminder[] }>(`${ctx.sessionPath}/reminders`);
  return reminders.filter((r) => r.state === 'active' && (r.id === g.reminder_id || r.prompt.includes(folder)));
}

async function newGoal(ctx: Ctx, objective: string, flags: Flags): Promise<number> {
  if (!objective) return missing('the goal, e.g. kortix goals new "EU billing live: invoices in EUR with VAT"');
  const off = await goalFlagsOff(ctx.client, ctx.projectId);
  if (off.length) {
    return fail(`Goals need these project features on: ${off.join(', ')}. Turn them on with ${off.map((f) => `kortix projects features enable ${f}`).join(' && ')} (a project admin), then run this again.`);
  }
  if (!existsSync(drivesRoot())) return fail('Files is not mounted in this session yet. Volumes is on: start a new session, then run this again.');
  const parent = flags.folder ?? join(drivesRoot(), 'company');
  if (!parent.startsWith(`${drivesRoot()}/`) || !existsSync(parent)) return fail(`${parent} is not a mounted folder under ${drivesRoot()}; see /drives/README.md.`);
  const slug = flags.slug ?? slugify(objective);
  const folder = join(parent, 'Goals', slug);
  if (existsSync(join(folder, 'GOAL.md')) || existsSync(join(folder, 'goal.json'))) return fail(`${folder} already holds a goal. Pick another --slug.`);
  const session = await ctx.client.get<ProjectSession & { created_by?: string; metadata?: Record<string, unknown> }>(ctx.sessionPath);
  await ctx.client.patch(ctx.sessionPath, { metadata: { unattended: 'true', goal: folder, goal_role: 'owner' } });
  const now = new Date().toISOString();
  const draft: ProjectGoalDocument = {
    version: 1,
    objective,
    status: 'draft',
    summary: '',
    assigned_user: flags.user ?? session.created_by ?? null,
    agent: flags.agent ?? process.env.KORTIX_AGENT_NAME ?? null,
    space: flags.space ?? null,
    success_criteria: [],
    items: [],
    links: [],
    waiting_on: null,
    heartbeat_every: flags.every ?? HEARTBEAT_EVERY,
    max_wakes_per_day: MAX_WAKES_PER_DAY,
    max_sessions: MAX_SESSIONS,
    sessions: [{ id: ctx.sessionId, role: 'owner', since: now }],
    reminder_id: null,
    next_wake_at: null,
    verified_by: null,
    transitions: [{ from: null, to: 'draft', at: now, reason: 'goal created', by: ctx.sessionId }],
    body: `# ${objective}\n\n## Context\n\nThe request in the person's words, constraints, and what was learned.\n`,
  };
  mkdirSync(join(folder, 'evidence'), { recursive: true });
  const reminder = await armHeartbeat(ctx, folder, draft);
  const goal = { ...draft, reminder_id: reminder.id, next_wake_at: reminder.next_fire_at ?? null };
  writeGoal(folder, goal);
  writeFileSync(join(folder, 'log.md'), `# Log\n\n- ${now} Goal created: ${objective}\n`);
  if (flags.json) emitJson({ folder, slug, reminder_id: reminder.id, next_wake_at: goal.next_wake_at });
  else {
    process.stdout.write(`${status.ok(`Goal created: ${C.bold}${folder}${C.reset}`)}\n`);
    process.stdout.write(`  ${C.dim}heartbeat ${C.reset}${reminder.id} (every ${goal.heartbeat_every}, next ${goal.next_wake_at ?? '—'})\n`);
    process.stdout.write(`  ${C.dim}next      ${C.reset}write done_criteria into GOAL.md, then kortix goals transition active --reason "…"\n`);
  }
  return 0;
}

async function transitionGoal(ctx: Ctx, folder: string, g: ProjectGoalDocument, to: string, flags: Flags): Promise<number> {
  if (!to) return missing('the target state: kortix goals transition <to> --reason "…" [<folder>]');
  const [heartbeats, session] = await Promise.all([
    heartbeatsOf(ctx, folder, g),
    ctx.client.get<ProjectSession & { metadata?: Record<string, unknown> }>(ctx.sessionPath),
  ]);
  const violations = transitionViolations(g, to, flags.reason, {
    activeHeartbeats: heartbeats.map((r) => r.id),
    unattended: ['true', true].includes(session.metadata?.unattended as never),
    sessionId: ctx.sessionId,
  });
  if (violations.length) return refuse(flags.json, g.status, to, violations);
  if (to === 'stopped') for (const r of heartbeats) await ctx.client.delete(`${ctx.sessionPath}/reminders/${r.id}`);
  const next = move(g, to as ProjectGoalStatus, flags.reason, ctx.sessionId);
  next.waiting_on = to === 'waiting_on_user' ? flags.reason : null;
  if (to === 'stopped') Object.assign(next, { reminder_id: null, next_wake_at: null });
  writeGoal(folder, next);
  appendLog(folder, `- ${now()} ${g.status} → ${to}: ${flags.reason}`);
  return done(flags.json, g.status, to);
}

async function verifyGoal(ctx: Ctx, folder: string, g: ProjectGoalDocument, flags: Flags): Promise<number> {
  const existingEvidence = new Set(g.success_criteria.map((c) => c.evidence).filter((p): p is string => !!p && existsSync(join(folder, p))));
  const violations = verifyViolations(g, { existingEvidence, sessionId: ctx.sessionId });
  if (violations.length) return refuse(flags.json, g.status, 'verifying', violations);
  // The engine starts the verifier, so no session contract ("do not spawn
  // sessions") stands between the owner and its verification.
  const verifier = await ctx.client.post<ProjectSession>(`/projects/${ctx.projectId}/sessions`, {
    initial_prompt: verifierPrompt(folder),
    title_source: `Verify goal ${folder.split('/').at(-1)}`,
    ...(g.agent ? { agent_name: g.agent } : {}),
    metadata: { unattended: 'true', goal: folder, goal_role: 'verifier' },
  });
  const next = move(g, 'verifying', 'every criterion has evidence', ctx.sessionId);
  next.sessions = [...g.sessions, { id: verifier.session_id, role: 'verifier', since: now() }];
  writeGoal(folder, next);
  appendLog(folder, `- ${now()} active → verifying: verifier session ${verifier.session_id} started`);
  if (flags.json) emitJson({ ok: true, from: g.status, to: 'verifying', verifier_session_id: verifier.session_id });
  else process.stdout.write(`${status.ok(`active → verifying: verifier ${verifier.session_id}`)}\n`);
  return 0;
}

async function verdictGoal(ctx: Ctx, verdict: string | undefined, folderArg: string | undefined, flags: Flags): Promise<number> {
  const folder =
    folderArg ??
    goalFolders().find((f) => [...(readGoal(f)?.sessions ?? [])].reverse().find((s) => s.role === 'verifier')?.id === ctx.sessionId);
  if (!folder) return fail('This session verifies no goal: pass the folder.');
  const g = readGoal(folder);
  if (!g) return fail(`${folder}/GOAL.md is missing or unreadable.`);
  const to: ProjectGoalStatus = verdict === 'pass' ? 'done' : 'active';
  const violations = verdictViolations(g, verdict ?? '', flags.reason, { sessionId: ctx.sessionId, verification: readReport(folder) });
  if (violations.length) return refuse(flags.json, g.status, to, violations);
  const next = move(g, to, `verifier ${verdict!.toUpperCase()}: ${flags.reason}`, ctx.sessionId);
  if (to === 'done') next.verified_by = ctx.sessionId;
  writeGoal(folder, next);
  appendLog(folder, `- ${now()} verifying → ${to}: verifier ${verdict!.toUpperCase()}: ${flags.reason}. Report: evidence/verification.md`);
  // Wake the owner: on done its turn-end check drops the heartbeat; on fail it works the findings.
  const owner = ownerOf(g);
  if (owner) {
    const session = await ctx.client.get<ProjectSession>(`/projects/${ctx.projectId}/sessions/${owner}`).catch(() => null);
    if (session) {
      await queueSessionPrompt(ctx.client, ctx.projectId, session, `${heartbeatPrompt(folder)} Verification ${verdict!.toUpperCase()}: ${flags.reason}`).catch(() => {});
    }
  }
  return done(flags.json, g.status, to);
}

async function handoverGoal(ctx: Ctx, folder: string, g: ProjectGoalDocument, flags: Flags): Promise<number> {
  const out: string[] = [];
  if (!flags.note?.trim()) out.push('Pass --note "<the state of play>": the next owner starts from it.');
  if (ownerOf(g) !== ctx.sessionId) out.push(`Only the owner session ${ownerOf(g) ?? '(none)'} hands the goal over.`);
  if (!OPEN.has(g.status)) out.push(`The goal is ${g.status} (closed).`);
  if (g.sessions.length >= sessionCap(g)) out.push(`The goal used ${g.sessions.length} of max_sessions ${sessionCap(g)}: ask the assigned user to raise it.`);
  if (out.length) return refuse(flags.json, g.status, g.status, out);
  appendLog(folder, `\n## Handover ${now()} from ${ctx.sessionId}\n\n${flags.note!.trim()}\n`);
  const next = await ctx.client.post<ProjectSession>(`/projects/${ctx.projectId}/sessions`, {
    initial_prompt: ownerPrompt(folder, ctx.sessionId),
    title_source: `Goal ${folder.split('/').at(-1)}`,
    ...(g.agent ? { agent_name: g.agent } : {}),
    metadata: { unattended: 'true', goal: folder, goal_role: 'owner' },
  });
  // A loop belongs to one session: the new owner's first turn end arms its own (check --enforce).
  for (const r of await heartbeatsOf(ctx, folder, g)) await ctx.client.delete(`${ctx.sessionPath}/reminders/${r.id}`);
  writeGoal(folder, { ...g, reminder_id: null, next_wake_at: null, sessions: [...g.sessions, { id: next.session_id, role: 'owner', since: now() }] });
  if (flags.json) emitJson({ ok: true, owner_session_id: next.session_id });
  else process.stdout.write(`${status.ok(`Handed over to ${next.session_id}`)}\n`);
  return 0;
}

async function checkGoals(ctx: Ctx, folderArg: string | undefined, flags: Flags): Promise<number> {
  const folders = folderArg ? [folderArg] : goalFolders().filter((f) => ownerOf(readGoal(f)) === ctx.sessionId);
  const results: Array<{ folder: string; violations: string[]; repaired: string[] }> = [];
  for (const folder of folders) {
    const g = readGoal(folder);
    const repaired = flags.enforce && g?.format === 'goal.md' && ownerOf(g) === ctx.sessionId ? await repair(ctx, folder, g) : [];
    results.push({ folder, violations: goalViolations(readGoal(folder), { verification: readReport(folder) }), repaired });
  }
  const broken = results.filter((r) => r.violations.length > 0);
  if (flags.json) emitJson({ goals: results });
  else if (!(flags.quiet && broken.length === 0)) {
    for (const r of results) {
      process.stdout.write(r.violations.length ? `${status.err(r.folder)}\n${r.violations.map((v) => `  - ${v}`).join('\n')}\n` : `${status.ok(r.folder)}\n`);
      for (const fix of r.repaired) process.stdout.write(`  ${C.dim}repaired: ${fix}${C.reset}\n`);
    }
  }
  if (flags.enforce) {
    const due = broken.filter((b) => takeEnforcementSlot(b.folder, Date.now()));
    if (due.length) {
      const session = await ctx.client.get<ProjectSession>(ctx.sessionPath);
      const text =
        '[GOAL CHECK] GOAL.md has problems only you can fix. Fix them now, then end the turn:\n' +
        due.map((b) => `${b.folder}\n${b.violations.map((v) => `- ${v}`).join('\n')}`).join('\n\n');
      await queueSessionPrompt(ctx.client, ctx.projectId, session, text);
    }
  }
  return broken.length ? 1 : 0;
}

/** The owner's turn ended: count the wake and fix, without the model, what code can fix. */
async function repair(ctx: Ctx, folder: string, start: ProjectGoalDocument): Promise<string[]> {
  const fixes: string[] = [];
  const heartbeats = await heartbeatsOf(ctx, folder, start);
  if (!OPEN.has(start.status)) {
    for (const r of heartbeats) await ctx.client.delete(`${ctx.sessionPath}/reminders/${r.id}`);
    if (heartbeats.length) {
      writeGoal(folder, { ...start, reminder_id: null, next_wake_at: null });
      fixes.push(`removed the heartbeat of a ${start.status} goal`);
    }
    return fixes;
  }
  const { doc, capped } = recordWake(start, new Date());
  let g = doc;
  const tomorrow = nextUtcDay(new Date());
  let keep: Reminder | undefined = heartbeats[0];
  for (const extra of heartbeats.slice(1)) await ctx.client.delete(`${ctx.sessionPath}/reminders/${extra.id}`);
  if (keep && capped && (keep.next_fire_at ?? '') < tomorrow) {
    await ctx.client.delete(`${ctx.sessionPath}/reminders/${keep.id}`);
    keep = undefined;
  }
  if (!keep) {
    keep = await armHeartbeat(ctx, folder, g, capped ? tomorrow : undefined);
    fixes.push(capped ? `wake cap ${g.max_wakes_per_day ?? MAX_WAKES_PER_DAY}/day reached: the heartbeat waits until ${tomorrow}` : 'armed a missing heartbeat');
    if (capped) appendLog(folder, `- ${now()} wake cap reached (${g.wake_count} wakes today): the heartbeat waits until ${tomorrow}`);
  }
  g = { ...g, reminder_id: keep.id, next_wake_at: keep.next_fire_at ?? g.next_wake_at ?? null };
  writeGoal(folder, g);
  return fixes;
}

const now = () => new Date().toISOString();

function move(g: ProjectGoalDocument, to: ProjectGoalStatus, reason: string, by: string): ProjectGoalDocument {
  return { ...g, status: to, transitions: [...g.transitions, { from: g.status, to, at: now(), reason, by }] };
}

function refuse(json: boolean, from: string, to: string, violations: string[]): number {
  if (json) emitJson({ ok: false, from, to, violations });
  else process.stderr.write(`${status.err(`${from} → ${to} refused`)}\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
  return 1;
}

function done(json: boolean, from: string, to: string): number {
  if (json) emitJson({ ok: true, from, to });
  else process.stdout.write(`${status.ok(`${from} → ${to}`)}\n`);
  return 0;
}

function summarize(folder: string) {
  const g = readGoal(folder);
  const criteria = g?.success_criteria ?? [];
  return {
    folder,
    slug: folder.split('/').pop()!,
    status: g?.status ?? 'invalid',
    objective: g?.objective ?? '',
    summary: g?.summary ?? '',
    assigned_user: g?.assigned_user ?? null,
    assigned_agent: g?.agent ?? null,
    criteria_met: criteria.filter((c) => c.met).length,
    criteria_total: criteria.length,
    waiting_on: g?.waiting_on ?? null,
    owner_session_id: ownerOf(g),
    next_wake_at: g?.next_wake_at ?? null,
    last_wake_at: g?.last_wake_at ?? null,
  };
}

function listGoals(json: boolean): number {
  const goals = goalFolders().map(summarize);
  if (json) {
    emitJson({ goals });
    return 0;
  }
  if (!goals.length) {
    process.stdout.write(`  ${C.dim}No goals in the mounted folders. Start one: kortix goals new "<goal>"${C.reset}\n`);
    return 0;
  }
  const w = Math.max(...goals.map((g) => g.slug.length), 4);
  process.stdout.write(`\n  ${C.dim}${pad('GOAL', w)}  ${pad('STATE', 16)}  CRITERIA  NEXT WAKE${C.reset}\n`);
  for (const g of goals) {
    process.stdout.write(`  ${pad(g.slug, w)}  ${pad(g.status, 16)}  ${pad(`${g.criteria_met}/${g.criteria_total}`, 8)}  ${g.next_wake_at ?? '—'}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function findGoalFolder(slug: string | undefined): string | undefined {
  const folders = goalFolders();
  return slug ? folders.find((f) => f.endsWith(`/${slug}`)) : folders.length === 1 ? folders[0] : undefined;
}

/** `kortix goals bind`: set or clear the goal's `space` / `assigned_agent` in GOAL.md. */
function bindGoal(slug: string | undefined, flags: Flags): number {
  if (!flags.clear && flags.space === undefined && flags.agent === undefined) return missing('--space <slug>, --agent <name> or --clear');
  const folder = findGoalFolder(slug);
  if (!folder) return fail(slug ? `No goal "${slug}" in the mounted folders.` : 'Name the goal: kortix goals bind <slug> (kortix goals ls lists them).');
  const g = readGoal(folder);
  if (!g || g.format !== 'goal.md') return fail(`${folder}/GOAL.md is missing or unreadable.`);
  const next = { ...g, space: flags.clear ? null : (flags.space ?? g.space ?? null), agent: flags.clear ? null : (flags.agent ?? g.agent ?? null) };
  writeGoal(folder, next);
  if (flags.json) emitJson({ folder, space: next.space, agent: next.agent });
  else process.stdout.write(`${status.ok(`Goal ${C.bold}${folder.split('/').at(-1)}${C.reset} is in ${next.space ?? (next.agent ? `${next.agent}'s space` : 'no space (project-wide)')}`)}\n`);
  return 0;
}

function goalStatus(slug: string | undefined, json: boolean): number {
  const folder = findGoalFolder(slug);
  if (!folder) return fail(slug ? `No goal "${slug}" in the mounted folders.` : 'Name the goal: kortix goals status <slug> (kortix goals ls lists them).');
  const s = summarize(folder);
  if (json) {
    emitJson(s);
    return 0;
  }
  process.stdout.write(`\n  ${C.bold}${s.objective}${C.reset}\n  ${C.dim}${s.folder}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}state    ${C.reset}${s.status}\n  ${C.dim}criteria ${C.reset}${s.criteria_met}/${s.criteria_total} met\n`);
  process.stdout.write(`  ${C.dim}agent    ${C.reset}${s.assigned_agent ?? '—'}\n  ${C.dim}owner    ${C.reset}${s.owner_session_id ?? '—'}\n  ${C.dim}next     ${C.reset}${s.next_wake_at ?? '—'}\n`);
  if (s.waiting_on) process.stdout.write(`\n  ${C.dim}Waiting on the assigned user:${C.reset} ${s.waiting_on}\n`);
  if (s.summary) process.stdout.write(`\n  ${s.summary}\n`);
  process.stdout.write('\n');
  return 0;
}
