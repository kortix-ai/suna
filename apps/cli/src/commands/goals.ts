/**
 * `kortix goals` — what a person wants plus a definition of done, worked by an
 * assigned agent until an independent verifier session confirms it.
 *
 * The Goals API is the authority (`/v1/workspaces/:projectId/goals/*`, wire
 * contract `packages/api-contract/src/goals.ts`). The `project_goals` row
 * holds state, pause, stop, owner, verifier, caps and counters. The API
 * derives who calls from the credential: inside a session that is the session
 * itself, so the API decides whether it is the goal's owner or verifier. This
 * CLI never writes a lifecycle field into the folder and never reads one back.
 *
 * The goal's folder in Files holds the brief (`GOAL.md`: the request and the
 * done criteria the owner writes while the goal is a draft), `log.md` and
 * `evidence/`. After each accepted write the CLI rewrites a read-only
 * lifecycle mirror block in GOAL.md's front matter for orientation only.
 *
 * Every write carries the `revision` of a fresh read. On `409 goal_conflict`
 * the CLI re-reads once and retries only when the move is still valid.
 */
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceGoalRecord, getWorkspaceGoal, listWorkspaceGoalRecords, MAX_GOAL_CRITERIA, parseGoalFile, postWorkspaceGoalAction, setWorkspaceGoalBinding, setWorkspaceGoalCriteria, WorkspaceGoalConflictError } from '@kortix/sdk';
import type { WorkspaceGoalCriterionStatus, WorkspaceGoalRecord, WorkspaceGoalRecordState, WorkspaceGoalVerification } from '@kortix/sdk';
import type { Auth } from '../api/auth.ts';
import { ApiError, type ApiClient, withCliErrors } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { queueSessionPrompt } from './sessions-queue.ts';

const HELP = help`Usage: kortix goals <subcommand> [options]

A goal is what someone wants plus a definition of done. The assigned agent
works it in an owner session until an independent verifier session passes
every criterion. The Goals API is the authority for state, pause, stop, owner,
verifier and caps. The folder in Files (Goals/<slug>/: GOAL.md brief, log.md,
evidence/) holds the brief and the artifacts. Lifecycle fields written into
GOAL.md change nothing. The kortix-goals skill describes the whole loop.

Lifecycle: draft → active ⇄ waiting_on_user; active → verifying →
done (every criterion passed) or active (any failed). A person pauses, resumes,
stops and restarts a goal from the Goals page; a session cannot.

Owner session:
  transition active --reason "<why>"
                      draft → active. Sends the done criteria listed under
                      "## Done criteria" in GOAL.md (1-8), then activates.
                      waiting_on_user → active: the answer reached you
                      another way (a channel reply); an answer from the
                      Goals page does this by itself.
  transition waiting_on_user --reason "<question>" [--chase-at <iso>]
                      Ask the assigned user. No turn runs until they answer,
                      or until --chase-at (60 min to 14 days ahead).
  progress [--met c1,c2] [--unmet c3] [--evidence c1=evidence/x.md]
           [--summary "<state of play>"]
                      Report criteria and the summary. Reports only: a
                      criterion is verified only by the verifier.
  verify              Every criterion reported met with an evidence file under
                      evidence/: the API starts a verifier session.
  handover --note "<state of play>"
                      Context nearly full: the API starts a fresh owner session
                      with the note.
  check [--enforce] [--quiet] [--turn <id>]
                      Report problems on the goals this session owns. With
                      --enforce (kortixd runs it after every turn): prompt the
                      owner when its goal is a draft or reported nothing for
                      3 wakes, at most 3 prompts per goal per 6 hours. One
                      check per turn id (default $KORTIX_TURN_MESSAGE_ID).

Verifier session:
  verdict --pass <ids> [--fail <ids>] [--inconclusive <ids>]
          [--note <id>="<why>"]... [--reason "<default note>"]
                      After writing evidence/verification.md. Exactly one
                      result per current criterion; a fail or inconclusive
                      needs a note. All pass → done; else → active.

Anyone:
  ls                  The goals you can read.
  status [<slug|goal_id>]
                      One goal: state, criteria (reported and verified), what
                      it waits on, owner, verifier, next wake, caps.
  new "<goal>" [--criterion "<text>"]... [--user <user_id>] [--agent <name>]
                      Create a goal. A person only: inside a session the API
                      refuses it; ask the person to create it on the Goals page.
  bind [<slug|goal_id>] --space <slug> | --agent <name> | --clear
                      Group the goal under a space or an agent. A person only.

Not here: stop, pause, resume, restart, raising caps. A person does those
from the Goals page.

Options:
  --goal <goal_id>    The goal (default: this session's goal_id, else the goal
                      this session owns or verifies).
  --json              Machine-readable output.
  -h, --help          Show this help.
`;

/** A goal as the Goals API returns it: `@kortix/sdk` owns the wire type. */
export type Goal = WorkspaceGoalRecord;

/** The codes of a Goals route's own refusal body; any other error is worded by `surfaceApiError`. */
const GOAL_ERRORS = new Set(['goal_conflict', 'goal_forbidden', 'goal_invalid', 'goal_not_found', 'goal_flag_off']);
const CHASE_MIN_MS = 60 * 60_000;
const CHASE_MAX_MS = 14 * 24 * 60 * 60_000;
const NOTE_MAX = 2_000;
/** Wakes with no new report before `check --enforce` prompts the owner. */
export const STALL_WAKES = 3;
const OPEN = new Set<WorkspaceGoalRecordState>(['draft', 'active', 'waiting_on_user', 'verifying']);
const SPACE_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const CRITERION_ID = /^c[1-9]\d*$/;

/** A move refused before any write: the reasons are printed as violations. */
class Refusal extends Error {
  constructor(
    readonly violations: string[],
    readonly from: string = '',
    readonly to: string = '',
  ) {
    super(violations.join(' '));
  }
}

function goalErrorBody(err: unknown): { error: string; message: string; violations?: string[] } | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.details;
  return body && typeof body === 'object' && typeof body.error === 'string' && GOAL_ERRORS.has(body.error) ? body : null;
}

// ── GOAL.md: the brief, and the read-only lifecycle mirror ───────────────────

const drivesRoot = () => process.env.KORTIX_DRIVES_ROOT ?? '/drives';

/** The goal folder as this box sees it: `box_folder` with /drives mapped to the mounted root. */
export function localFolder(g: Pick<Goal, 'box_folder'>, root = drivesRoot()): string {
  return g.box_folder.replace(/^\/drives(?=\/|$)/, root);
}

const CRITERIA_HEADING = /^#{2,3}\s+(done criteria|definition of done|success criteria|criteria)\s*(\([^)]*\))?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const ID_PREFIX = /^(?:\*\*)?c\d+(?:\*\*)?\s*[:.)\-–]\s*/i;

/**
 * The done criteria the owner wrote in GOAL.md: the list items under a
 * `## Done criteria` heading (a leading `c1:` is dropped). A legacy GOAL.md
 * with `done_criteria:` front matter reads too. Lifecycle keys are not read.
 */
export function briefCriteria(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => CRITERIA_HEADING.test(l.trim()));
  if (start >= 0) {
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,3}\s/.test(line)) break;
      const item = LIST_ITEM.exec(line);
      const textOnly = item?.[1]?.replace(ID_PREFIX, '').trim();
      if (textOnly) out.push(textOnly);
    }
    if (out.length) return out;
  }
  return (parseGoalFile(text)?.success_criteria ?? []).map((c) => String(c.text ?? '').trim()).filter(Boolean);
}

const MIRROR_START = '# kortix-lifecycle: read-only mirror. The Goals API is the authority; edits here are ignored.';
const MIRROR_END = '# end kortix-lifecycle';

/** GOAL.md text with the lifecycle mirror block (re)written at the end of its front matter. */
export function withLifecycleMirror(text: string, g: Pick<Goal, 'state' | 'revision' | 'owner_session_id' | 'paused_at'>): string {
  const block = [
    MIRROR_START,
    `lifecycle_state: ${g.state}`,
    `lifecycle_revision: ${g.revision}`,
    `lifecycle_owner_session_id: ${g.owner_session_id ?? 'null'}`,
    `lifecycle_paused_at: ${g.paused_at ? JSON.stringify(g.paused_at) : 'null'}`,
    MIRROR_END,
  ];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  if (end < 0) return ['---', ...block, '---', ...lines].join('\n');
  const front = lines.slice(1, end);
  const s = front.indexOf(MIRROR_START);
  const e = front.indexOf(MIRROR_END);
  const kept = s >= 0 && e >= s ? [...front.slice(0, s), ...front.slice(e + 1)] : front;
  return ['---', ...kept, ...block, ...lines.slice(end)].join('\n');
}

/** Best effort: the mirror is orientation only, so a missing or odd GOAL.md is left alone. */
function writeMirror(g: Goal): void {
  const path = join(localFolder(g), 'GOAL.md');
  let fd: number | undefined;
  try {
    // One descriptor, opened without following a symlink, for the check, the read and the write.
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return;
    const next = withLifecycleMirror(readFileSync(fd, 'utf8'), g);
    ftruncateSync(fd, 0);
    writeSync(fd, next, 0);
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The verifier's report, read without following a symlink. Null: not a regular, non-empty file. */
function readVerificationReport(g: Goal): string | null {
  const path = join(localFolder(g), 'evidence', 'verification.md');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const text = readFileSync(fd, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── Flags ────────────────────────────────────────────────────────────────────

interface Flags {
  goal?: string;
  reason: string;
  chaseAt?: string;
  summary?: string;
  met: string[];
  unmet: string[];
  evidence: string[];
  pass: string[];
  fail: string[];
  inconclusive: string[];
  notes: string[];
  criterion: string[];
  user?: string;
  agent?: string;
  space?: string;
  turn?: string;
  clear: boolean;
  enforce: boolean;
  quiet: boolean;
  json: boolean;
}

const ids = (values: string[]) => values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

function parseFlags(rest: string[]): Flags {
  return {
    goal: takeFlagValue(rest, ['--goal']),
    reason: takeFlagValue(rest, ['--reason']) ?? '',
    chaseAt: takeFlagValue(rest, ['--chase-at']),
    summary: takeFlagValue(rest, ['--summary']),
    met: ids(takeFlagValues(rest, ['--met'])),
    unmet: ids(takeFlagValues(rest, ['--unmet'])),
    evidence: takeFlagValues(rest, ['--evidence']),
    pass: ids(takeFlagValues(rest, ['--pass'])),
    fail: ids(takeFlagValues(rest, ['--fail'])),
    inconclusive: ids(takeFlagValues(rest, ['--inconclusive'])),
    notes: takeFlagValues(rest, ['--note']),
    criterion: takeFlagValues(rest, ['--criterion']),
    user: takeFlagValue(rest, ['--user']),
    agent: takeFlagValue(rest, ['--agent']),
    space: takeFlagValue(rest, ['--space']),
    turn: takeFlagValue(rest, ['--turn']),
    clear: takeFlagBool(rest, ['--clear']),
    enforce: takeFlagBool(rest, ['--enforce']),
    quiet: takeFlagBool(rest, ['--quiet']),
    json: takeFlagBool(rest, ['--json']),
  };
}

const SUBCOMMANDS = ['new', 'transition', 'progress', 'verify', 'verdict', 'handover', 'check', 'bind', 'ls', 'list', 'status'];

interface Ctx {
  client: ApiClient;
  auth: Auth;
  projectId: string;
  sessionId: string | null;
}

export async function runGoals(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  const sub = rest.shift();
  if (!sub || !SUBCOMMANDS.includes(sub)) return fail(`Unknown subcommand "${sub ?? ''}". Run \`kortix goals --help\`.`);
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (flags.space !== undefined && !SPACE_SLUG.test(flags.space)) return fail(`--space "${flags.space}" is not a space slug.`);
  if (flags.agent !== undefined && !AGENT_NAME.test(flags.agent)) return fail(`--agent "${flags.agent}" is not an agent name.`);

  const resolved = await resolveProjectContext({});
  if (!resolved) return sub === 'ls' || sub === 'list' || sub === 'status' ? listLocal(rest[0], flags.json) : 1;
  const ctx: Ctx = {
    client: resolved.client,
    auth: resolved.auth,
    projectId: resolved.projectId,
    sessionId: process.env.KORTIX_SESSION_ID || null,
  };
  const inSession = ['transition', 'progress', 'verify', 'verdict', 'handover', 'check'];
  if (inSession.includes(sub) && !ctx.sessionId) return fail(`No $KORTIX_SESSION_ID: kortix goals ${sub} runs inside the goal's session.`);
  try {
    switch (sub) {
      case 'new':
        return await newGoal(ctx, rest.join(' ').trim(), flags);
      case 'transition':
        return await transitionGoal(ctx, rest[0] ?? '', flags);
      case 'progress':
        return await progressGoal(ctx, flags);
      case 'verify':
        return await verifyGoal(ctx, flags);
      case 'verdict':
        return await verdictGoal(ctx, rest[0], flags);
      case 'handover':
        return await handoverGoal(ctx, flags);
      case 'check':
        return await checkGoals(ctx, flags);
      case 'bind':
        return await bindGoal(ctx, rest[0], flags);
      case 'status':
        return await goalStatus(ctx, rest[0], flags);
      default:
        return await listGoals(ctx, flags);
    }
  } catch (err) {
    return failure(err, flags.json);
  }
}

// ── API access ───────────────────────────────────────────────────────────────

/** A Goals SDK call as this CLI's credential. A failure is the CLI's `ApiError`, as an `ApiClient` request's is. */
const api = <T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> => withCliErrors(ctx.auth, fn);

const getGoal = async (ctx: Ctx, id: string): Promise<Goal> => (await api(ctx, () => getWorkspaceGoal(ctx.projectId, id))).record;
const listByRole = (ctx: Ctx, role: 'owner' | 'verifier'): Promise<Goal[]> => api(ctx, () => listWorkspaceGoalRecords(ctx.projectId, { role, sessionId: ctx.sessionId! }));

/**
 * This session's goal, freshly read: `--goal`, else the session's `goal_id`
 * metadata, else the one open goal it owns (or verifies). Never a folder name.
 */
async function resolveGoal(ctx: Ctx, role: 'owner' | 'verifier', explicit?: string): Promise<Goal> {
  if (explicit) return getGoal(ctx, explicit);
  const session = await ctx.client
    .get<{ metadata?: Record<string, unknown> }>(`/workspaces/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId!)}`)
    .catch(() => null);
  const fromMeta = session?.metadata?.goal_id;
  if (typeof fromMeta === 'string' && fromMeta) return getGoal(ctx, fromMeta);
  const goals = await listByRole(ctx, role);
  const open = goals.filter((g) => OPEN.has(g.state));
  const pick = open.length === 1 ? open[0] : goals.length === 1 ? goals[0] : undefined;
  if (!pick) {
    throw new Refusal([
      goals.length
        ? `This session is the ${role} of ${goals.length} goals: pass --goal <goal_id> (kortix goals ls lists them).`
        : `This session is the ${role} of no goal. A goal's own ${role} session runs this command.`,
    ]);
  }
  return getGoal(ctx, pick.goal_id);
}

interface Move {
  to: string;
  /** Why the move is not valid on `g` now. Empty: send it. */
  valid(g: Goal): string[];
  send(g: Goal): Promise<Goal>;
}

/** Send `move` with `g.revision`. On `409 goal_conflict`: re-read once, and retry only when the move is still valid. */
async function commit(ctx: Ctx, start: Goal, move: Move): Promise<Goal> {
  let g = start;
  for (let attempt = 0; ; attempt++) {
    const violations = move.valid(g);
    if (violations.length) throw new Refusal(violations, g.state, move.to);
    // The conflict comes back as a value so the CLI's ApiError still wraps every other failure.
    const sent = await api(ctx, () => move.send(g).catch((err: unknown) => (attempt === 0 && err instanceof WorkspaceGoalConflictError ? err : Promise.reject(err))));
    if (!(sent instanceof WorkspaceGoalConflictError)) {
      writeMirror(sent);
      return sent;
    }
    g = sent.goal.record;
  }
}

const inState = (g: Goal, states: WorkspaceGoalRecordState[], what: string): string[] =>
  states.includes(g.state) ? [] : [`The goal is ${g.state}; ${what} runs on a goal that is ${states.join(' or ')}.`];
const notPaused = (g: Goal): string[] => (g.paused_at ? ['A person paused this goal from the Goals page. Do no work on it: end the turn.'] : []);

function failure(err: unknown, json: boolean): number {
  if (err instanceof Refusal) return refuse(json, err.from, err.to, err.violations);
  const body = goalErrorBody(err);
  if (body) {
    const violations = body.violations?.length ? body.violations : [];
    if (json) emitJson({ ok: false, error: body.error, message: body.message, violations });
    else process.stderr.write(`${status.err(body.message)}\n${violations.map((v) => `  - ${v}`).join('\n')}${violations.length ? '\n' : ''}`);
    return 1;
  }
  return surfaceApiError(err);
}

function refuse(json: boolean, from: string, to: string, violations: string[]): number {
  if (json) emitJson({ ok: false, from, to, violations });
  else process.stderr.write(`${status.err(from && to ? `${from} → ${to} refused` : 'Refused')}\n${violations.map((v) => `  - ${v}`).join('\n')}\n`);
  return 1;
}

function done(json: boolean, from: string, g: Goal, extra: Record<string, unknown> = {}): number {
  if (json) emitJson({ ok: true, from, to: g.state, revision: g.revision, goal_id: g.goal_id, ...extra });
  else process.stdout.write(`${status.ok(from === g.state ? `${g.title}: ${g.state} (revision ${g.revision})` : `${from} → ${g.state}`)}\n`);
  return 0;
}

// ── Owner commands ───────────────────────────────────────────────────────────

async function transitionGoal(ctx: Ctx, to: string, flags: Flags): Promise<number> {
  if (!to) return missing('the target state: kortix goals transition active|waiting_on_user --reason "…"');
  if (to === 'stopped') {
    return refuse(flags.json, '', 'stopped', ['Only a person stops a goal, from the Goals page. If the person asked you to stop, tell them to press Stop there.']);
  }
  if (to === 'verifying') return refuse(flags.json, '', to, ['Run kortix goals verify: the API checks the evidence and starts the verifier.']);
  if (to === 'done') return refuse(flags.json, '', to, ['Only the verifier ends a goal: kortix goals verdict, run in the verifier session.']);
  if (to !== 'active' && to !== 'waiting_on_user') return refuse(flags.json, '', to, [`"${to}" is not a move. Moves: active, waiting_on_user.`]);
  if (!flags.reason.trim()) return refuse(flags.json, '', to, [to === 'waiting_on_user' ? 'Pass --reason "<the question for the assigned user>".' : 'Pass --reason "<why>": every move is logged.']);
  const g = await resolveGoal(ctx, 'owner', flags.goal);
  return to === 'active' ? activate(ctx, g, flags) : wait(ctx, g, flags);
}

async function activate(ctx: Ctx, start: Goal, flags: Flags): Promise<number> {
  // waiting_on_user → active: the answer reached this session another way (a channel reply, email).
  // An answer from the Goals page moves it back by itself.
  let g = start;
  if (g.state === 'draft') {
    const path = join(localFolder(g), 'GOAL.md');
    const written = existsSync(path) ? briefCriteria(readFileSync(path, 'utf8')) : [];
    const current = g.criteria.map((c) => c.text);
    if (written.length > MAX_GOAL_CRITERIA) return refuse(flags.json, g.state, 'active', [`GOAL.md lists ${written.length} done criteria; the limit is ${MAX_GOAL_CRITERIA}.`]);
    if (written.length === 0 && current.length === 0) {
      return refuse(flags.json, g.state, 'active', [`Write 1 to ${MAX_GOAL_CRITERIA} done criteria as a list under "## Done criteria" in ${path}, each checkable by someone else.`]);
    }
    if (written.length && JSON.stringify(written) !== JSON.stringify(current)) {
      g = await commit(ctx, g, {
        to: 'draft',
        valid: (x) => inState(x, ['draft'], 'setting criteria from a session'),
        send: (x) => setWorkspaceGoalCriteria(ctx.projectId, x, written),
      });
    }
  }
  const next = await commit(ctx, g, {
    to: 'active',
    valid: (x) => [...inState(x, ['draft', 'waiting_on_user'], 'activate'), ...notPaused(x), ...(x.criteria.length ? [] : ['The goal has no done criteria.'])],
    send: (x) => postWorkspaceGoalAction(ctx.projectId, x, 'activate', { reason: flags.reason }),
  });
  return done(flags.json, start.state, next);
}

/** Why `--chase-at` is refused. Empty: allowed. */
export function chaseViolations(chaseAt: string | undefined, now: number): string[] {
  if (chaseAt === undefined) return [];
  const at = Date.parse(chaseAt);
  if (!Number.isFinite(at) || !/^\d{4}-\d{2}-\d{2}T/.test(chaseAt)) return [`--chase-at "${chaseAt}" is not an ISO 8601 time, for example 2026-11-10T09:00:00Z.`];
  if (at - now < CHASE_MIN_MS || at - now > CHASE_MAX_MS) return ['--chase-at must be 60 minutes to 14 days from now.'];
  return [];
}

async function wait(ctx: Ctx, g: Goal, flags: Flags): Promise<number> {
  const chase = chaseViolations(flags.chaseAt, Date.now());
  if (chase.length) return refuse(flags.json, g.state, 'waiting_on_user', chase);
  const next = await commit(ctx, g, {
    to: 'waiting_on_user',
    valid: (x) => [...inState(x, ['active'], 'wait'), ...notPaused(x)],
    send: (x) => postWorkspaceGoalAction(ctx.projectId, x, 'wait', { question: flags.reason, ...(flags.chaseAt ? { chase_at: flags.chaseAt } : {}) }),
  });
  if (!flags.json) {
    process.stdout.write(`${status.ok(`${g.state} → ${next.state}`)}\n`);
    process.stdout.write(`  ${C.dim}No turn runs until the assigned user answers${flags.chaseAt ? ` or ${flags.chaseAt}` : ''}. End the turn now.${C.reset}\n`);
    return 0;
  }
  return done(true, g.state, next);
}

/** A path the API accepts as evidence: relative, under evidence/, no `..`. */
export function evidencePathOk(path: string): boolean {
  return /^evidence\/[^\0]+$/.test(path) && !path.split('/').some((s) => s === '..' || s === '.' || s === '') && !path.includes('\\');
}

/** The criteria part of a `progress` request, or the reasons it is refused. */
export function progressCriteria(
  criteria: Pick<WorkspaceGoalCriterionStatus, 'id' | 'reported_met' | 'evidence'>[],
  f: Pick<Flags, 'met' | 'unmet' | 'evidence'>,
): { criteria: Array<{ id: string; reported_met: boolean; evidence?: string | null }>; violations: string[] } {
  const known = new Map(criteria.map((c) => [c.id, c]));
  const violations: string[] = [];
  const evidence = new Map<string, string>();
  for (const pair of f.evidence) {
    const eq = pair.indexOf('=');
    const [id, path] = eq > 0 ? [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] : ['', ''];
    if (!id || !path) violations.push(`--evidence takes <id>=evidence/<file>, got "${pair}".`);
    else if (!evidencePathOk(path)) violations.push(`--evidence ${id}: "${path}" must be a relative path under evidence/, without "..".`);
    else evidence.set(id, path);
  }
  const touched = new Set([...f.met, ...f.unmet, ...evidence.keys()]);
  for (const id of touched) if (!known.has(id)) violations.push(`No criterion ${id}. Criteria: ${[...known.keys()].join(', ') || '(none)'}.`);
  for (const id of f.met) if (f.unmet.includes(id)) violations.push(`${id} is in both --met and --unmet.`);
  if (violations.length) return { criteria: [], violations };
  return {
    criteria: [...touched].map((id) => ({
      id,
      reported_met: f.met.includes(id) ? true : f.unmet.includes(id) ? false : known.get(id)!.reported_met,
      ...(evidence.has(id) ? { evidence: evidence.get(id)! } : {}),
    })),
    violations: [],
  };
}

async function progressGoal(ctx: Ctx, flags: Flags): Promise<number> {
  if (!flags.met.length && !flags.unmet.length && !flags.evidence.length && flags.summary === undefined) {
    return missing('--met <ids>, --unmet <ids>, --evidence <id>=evidence/<file> or --summary "…"');
  }
  const g = await resolveGoal(ctx, 'owner', flags.goal);
  const next = await commit(ctx, g, {
    to: g.state,
    valid: (x) => {
      const { violations } = progressCriteria(x.criteria, flags);
      return [...inState(x, ['draft', 'active', 'waiting_on_user'], 'progress'), ...notPaused(x), ...violations];
    },
    send: (x) => {
      const { criteria } = progressCriteria(x.criteria, flags);
      return postWorkspaceGoalAction(ctx.projectId, x, 'progress', { ...(flags.summary !== undefined ? { summary: flags.summary } : {}), ...(criteria.length ? { criteria } : {}) });
    },
  });
  if (flags.json) return done(true, g.state, next);
  const met = next.criteria.filter((c) => c.reported_met).length;
  process.stdout.write(`${status.ok(`Progress recorded: ${met}/${next.criteria.length} criteria reported met (revision ${next.revision})`)}\n`);
  return 0;
}

async function verifyGoal(ctx: Ctx, flags: Flags): Promise<number> {
  const g = await resolveGoal(ctx, 'owner', flags.goal);
  const next = await commit(ctx, g, {
    to: 'verifying',
    valid: (x) => [...inState(x, ['active'], 'verify'), ...notPaused(x)],
    send: (x) => postWorkspaceGoalAction(ctx.projectId, x, 'request-verification', {}),
  });
  if (flags.json) return done(true, g.state, next, { verifier_session_id: next.verification?.verifier_session_id ?? null });
  process.stdout.write(`${status.ok(`${g.state} → ${next.state}: verifier ${next.verification?.verifier_session_id ?? '(starting)'}`)}\n`);
  process.stdout.write(`  ${C.dim}End the turn. The verdict wakes this goal's owner.${C.reset}\n`);
  return 0;
}

async function handoverGoal(ctx: Ctx, flags: Flags): Promise<number> {
  const note = flags.notes.join('\n\n').trim();
  if (!note) return missing('--note "<the state of play>": the next owner starts from it');
  const g = await resolveGoal(ctx, 'owner', flags.goal);
  const next = await commit(ctx, g, {
    to: g.state,
    valid: (x) => [...(OPEN.has(x.state) ? [] : [`The goal is ${x.state} (closed).`]), ...notPaused(x)],
    send: (x) => postWorkspaceGoalAction(ctx.projectId, x, 'handover', { note }),
  });
  if (flags.json) return done(true, g.state, next, { owner_session_id: next.owner_session_id });
  process.stdout.write(`${status.ok(`Handed over to ${next.owner_session_id ?? '(new owner)'}`)}\n`);
  process.stdout.write(`  ${C.dim}Stop working this goal now.${C.reset}\n`);
  return 0;
}

// ── Verifier ─────────────────────────────────────────────────────────────────

/** One result per current criterion from `--pass/--fail/--inconclusive/--note`, or the reasons it is refused. */
export function verdictResults(
  criteria: Pick<WorkspaceGoalCriterionStatus, 'id'>[],
  f: Pick<Flags, 'pass' | 'fail' | 'inconclusive' | 'notes' | 'reason'>,
): { results: WorkspaceGoalVerification['results']; violations: string[] } {
  const violations: string[] = [];
  const known = criteria.map((c) => c.id);
  const notes = new Map<string, string>();
  for (const pair of f.notes) {
    const eq = pair.indexOf('=');
    const id = eq > 0 ? pair.slice(0, eq).trim() : '';
    const text = eq > 0 ? pair.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1') : '';
    if (!id || !text) violations.push(`--note takes <id>="<why>", got "${pair}".`);
    else if (!known.includes(id)) violations.push(`--note ${id}: no criterion ${id}.`);
    else if (text.length > NOTE_MAX) violations.push(`--note ${id} is ${text.length} characters; the limit is ${NOTE_MAX}.`);
    else notes.set(id, text);
  }
  const given = new Map<string, WorkspaceGoalVerification['results'][number]['result']>();
  for (const [result, list] of [['pass', f.pass], ['fail', f.fail], ['inconclusive', f.inconclusive]] as const) {
    for (const id of list) {
      if (!known.includes(id)) violations.push(`No criterion ${id}. Criteria: ${known.join(', ') || '(none)'}.`);
      else if (given.has(id)) violations.push(`${id} has two results (${given.get(id)} and ${result}): give it one.`);
      else given.set(id, result);
    }
  }
  for (const id of known) if (!given.has(id)) violations.push(`Criterion ${id} has no result: add it to --pass, --fail or --inconclusive.`);
  const fallback = f.reason.trim();
  for (const [id, result] of given) {
    if (result !== 'pass' && !notes.has(id) && !fallback) violations.push(`${id} is ${result}: say what is missing with --note ${id}="…".`);
  }
  if (violations.length) return { results: [], violations };
  return { results: known.map((id) => ({ criterion_id: id, result: given.get(id)!, note: notes.get(id) ?? fallback })), violations: [] };
}

async function verdictGoal(ctx: Ctx, legacy: string | undefined, flags: Flags): Promise<number> {
  if (legacy === 'pass' || legacy === 'fail') {
    return refuse(flags.json, '', '', [`"verdict ${legacy}" is gone: give one result per criterion, e.g. kortix goals verdict --pass c1,c2 --fail c3 --note c3="charged in USD".`]);
  }
  if (!flags.pass.length && !flags.fail.length && !flags.inconclusive.length) return missing('one result per criterion: --pass <ids> [--fail <ids>] [--inconclusive <ids>]');
  const g = await resolveGoal(ctx, 'verifier', flags.goal);
  if (readVerificationReport(g) === null) {
    return refuse(flags.json, g.state, '', [`Write your report to ${join(localFolder(g), 'evidence', 'verification.md')} first: one line per criterion with the result and why.`]);
  }
  const next = await commit(ctx, g, {
    to: 'done',
    valid: (x) => [...inState(x, ['verifying'], 'verdict'), ...verdictResults(x.criteria, flags).violations],
    send: (x) => postWorkspaceGoalAction(ctx.projectId, x, 'verdict', { results: verdictResults(x.criteria, flags).results }),
  });
  if (flags.json) return done(true, g.state, next);
  process.stdout.write(`${status.ok(`${g.state} → ${next.state}`)}\n`);
  process.stdout.write(`  ${C.dim}Your work on this goal is done. End the turn.${C.reset}\n`);
  return 0;
}

// ── check ────────────────────────────────────────────────────────────────────

const STATE_DIR = () => join(homedir(), '.kortix', 'state');
const ENFORCE_MAX = 3;
const ENFORCE_WINDOW_MS = 6 * 60 * 60_000;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

/** Records one enforcement prompt for `key`; false when the cap for the window is used up. */
export function takeEnforcementSlot(key: string, now: number, path = join(STATE_DIR(), 'goal-check.json')): boolean {
  const state = readJson<Record<string, number[]>>(path, {});
  const recent = (state[key] ?? []).filter((t) => now - t < ENFORCE_WINDOW_MS);
  if (recent.length >= ENFORCE_MAX) return false;
  state[key] = [...recent, now];
  writeJson(path, state);
  return true;
}

interface WakeRecord {
  turn: string | null;
  report: string;
  unchanged: number;
}

/** What the owner reported: changes when it calls `progress`, or the state moves. */
const reportSignature = (g: Goal) => JSON.stringify([g.state, g.summary, g.criteria.map((c) => [c.id, c.text, c.reported_met, c.evidence])]);

/** What the owner must do on `g`, given how many wakes in a row reported nothing. */
export function goalProblems(g: Goal): string[] {
  // Paused, closed or blocked (wake cap, credits, flag off, a lost owner): the API holds it; a nudge would be a turn the admission gate refused.
  if (g.paused_at || g.blocked_reason || !OPEN.has(g.state)) return [];
  if (g.state === 'draft' && g.criteria.length === 0) {
    return [`Draft with no done criteria: write 1 to ${MAX_GOAL_CRITERIA} under "## Done criteria" in GOAL.md, then kortix goals transition active --reason "…".`];
  }
  // Only a draft is nudged: it has no heartbeat, so without the nudge nothing wakes it. An active
  // goal is woken by heartbeat fires the API admits within its wake cap; a nudge would be a turn outside it.
  if (g.state === 'draft') return ['Still a draft: check the done criteria in GOAL.md, then kortix goals transition active --reason "…".'];
  return [];
}

async function checkGoals(ctx: Ctx, flags: Flags): Promise<number> {
  const goals = await listByRole(ctx, 'owner');
  const turn = flags.turn ?? (process.env.KORTIX_TURN_MESSAGE_ID || null);
  const wakesPath = join(STATE_DIR(), 'goal-wakes.json');
  const wakes = readJson<Record<string, WakeRecord>>(wakesPath, {});
  const results: Array<{ goal_id: string; title: string; state: WorkspaceGoalRecordState; problems: string[]; notes: string[]; skipped?: string }> = [];
  for (const g of goals) {
    const notes = [
      ...(g.paused_at ? [`paused by a person at ${g.paused_at}`] : []),
      ...(g.blocked_reason ? [`blocked: ${g.blocked_reason}`] : []),
      ...(g.state === 'waiting_on_user' && g.waiting_on ? [`waiting on the assigned user: ${g.waiting_on}`] : []),
    ];
    const prev = wakes[g.goal_id] ?? { turn: null, report: '', unchanged: 0 };
    if (flags.enforce && turn && prev.turn === turn) {
      results.push({ goal_id: g.goal_id, title: g.title, state: g.state, problems: [], notes, skipped: `turn ${turn} already checked` });
      continue;
    }
    const report = reportSignature(g);
    const counted = flags.enforce && g.state === 'active' && !g.paused_at;
    const unchanged = counted ? (prev.report === report ? prev.unchanged + 1 : 0) : prev.unchanged;
    if (flags.enforce) wakes[g.goal_id] = { turn, report, unchanged };
    if (g.state === 'active' && !g.paused_at && !g.blocked_reason && unchanged >= STALL_WAKES) {
      notes.push(`Nothing reported for ${unchanged} wakes: record what changed with kortix goals progress, ask with transition waiting_on_user, or hand over.`);
    }
    results.push({ goal_id: g.goal_id, title: g.title, state: g.state, problems: goalProblems(g), notes });
  }
  if (flags.enforce) writeJson(wakesPath, wakes);
  const broken = results.filter((r) => r.problems.length > 0);
  if (flags.json) emitJson({ goals: results });
  else if (!(flags.quiet && broken.length === 0)) {
    if (!results.length) process.stdout.write(`  ${C.dim}This session owns no goal.${C.reset}\n`);
    for (const r of results) {
      const head = `${r.title} (${r.goal_id}) ${r.state}`;
      process.stdout.write(r.problems.length ? `${status.err(head)}\n${r.problems.map((p) => `  - ${p}`).join('\n')}\n` : `${status.ok(head)}\n`);
      for (const n of [...r.notes, ...(r.skipped ? [r.skipped] : [])]) process.stdout.write(`  ${C.dim}${n}${C.reset}\n`);
    }
  }
  if (!flags.enforce) return broken.length ? 1 : 0;
  const due = broken.filter((b) => takeEnforcementSlot(b.goal_id, Date.now()));
  if (due.length) {
    const session = await ctx.client.get<ProjectSession>(`/workspaces/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId!)}`);
    const text =
      '[GOAL CHECK] A goal this session owns needs you. Do this now, then end the turn:\n' +
      due.map((b) => `${b.title} (${b.goal_id})\n${b.problems.map((p) => `- ${p}`).join('\n')}`).join('\n\n');
    await queueSessionPrompt(ctx.client, ctx.projectId, session, text);
  }
  // --enforce exits 0 once it handled what it found; non-zero only when it could not run.
  return 0;
}

// ── Person commands: new, bind ───────────────────────────────────────────────

async function newGoal(ctx: Ctx, brief: string, flags: Flags): Promise<number> {
  if (!brief) return missing('the goal, e.g. kortix goals new "EU billing live: invoices in EUR with VAT"');
  try {
    const goal = await api(ctx, () => createWorkspaceGoalRecord(ctx.projectId, {
      goal_id: randomUUID(),
      brief,
      ...(flags.criterion.length ? { criteria: flags.criterion } : {}),
      ...(flags.agent ? { agent: flags.agent } : {}),
      ...(flags.user ? { assigned_user_id: flags.user } : {}),
    }));
    if (flags.json) emitJson({ ok: true, goal });
    else {
      process.stdout.write(`${status.ok(`Goal created: ${C.bold}${goal.title}${C.reset} (${goal.goal_id})`)}\n`);
      process.stdout.write(`  ${C.dim}folder ${C.reset}${goal.folder}\n  ${C.dim}owner  ${C.reset}${goal.owner_session_id ?? '(starting)'}\n`);
    }
    return 0;
  } catch (err) {
    const body = goalErrorBody(err);
    if (body?.error === 'goal_forbidden' && ctx.sessionId) {
      if (flags.json) emitJson({ ok: false, error: body.error, message: body.message });
      else {
        process.stderr.write(`${status.err(body.message)}\n`);
        process.stderr.write(
          '  A goal\'s own session cannot start another goal. Note the follow-up in log.md, or ask the person to\n' +
            '  create it from the Goals page.\n',
        );
      }
      return 1;
    }
    throw err;
  }
}

/** The goal named by `ref` (slug or goal_id) or `--goal`; in a session with neither, this session's goal. */
async function findGoal(ctx: Ctx, ref: string | undefined, explicit: string | undefined): Promise<Goal> {
  const id = ref ?? explicit;
  if (!id && ctx.sessionId) return resolveGoal(ctx, 'owner');
  const goals = await api(ctx, () => listWorkspaceGoalRecords(ctx.projectId));
  const hit = id ? goals.filter((g) => g.goal_id === id || g.slug === id) : goals;
  if (hit.length !== 1) {
    throw new Refusal([
      id ? (hit.length ? `"${id}" names ${hit.length} goals: pass the goal_id.` : `No goal "${id}" you can read.`) : 'Name the goal: <slug|goal_id> (kortix goals ls lists them).',
    ]);
  }
  return getGoal(ctx, hit[0]!.goal_id);
}

async function bindGoal(ctx: Ctx, ref: string | undefined, flags: Flags): Promise<number> {
  if (!flags.clear && flags.space === undefined && flags.agent === undefined) return missing('--space <slug>, --agent <name> or --clear');
  const g = await findGoal(ctx, ref, flags.goal);
  const next = await commit(ctx, g, {
    to: g.state,
    valid: () => [],
    send: async (x) =>
      (await setWorkspaceGoalBinding({ projectId: ctx.projectId, goalId: x.goal_id, revision: x.revision }, {
        ...(flags.clear ? { space: null, agent: null } : {}),
        ...(flags.space !== undefined ? { space: flags.space } : {}),
        ...(flags.agent !== undefined ? { agent: flags.agent } : {}),
      })).projectGoal.record,
  });
  if (flags.json) emitJson({ ok: true, goal_id: next.goal_id, space: next.space, agent: next.agent });
  else process.stdout.write(`${status.ok(`Goal ${C.bold}${next.slug}${C.reset} is in ${next.space ?? (next.agent ? `${next.agent}'s space` : 'no space (project-wide)')}`)}\n`);
  return 0;
}

// ── ls / status ──────────────────────────────────────────────────────────────

/** The API cannot answer goals at all (offline, 5xx, or an API without the routes): fall back to the folders. */
function unreachable(err: unknown): boolean {
  if (!(err instanceof ApiError) || goalErrorBody(err)) return false;
  const code = (err.body as { code?: string } | null)?.code;
  return err.status === 0 || err.status >= 500 || (err.status === 404 && code !== 'feature_disabled');
}

const criteriaCell = (g: Goal) => `${g.criteria.filter((c) => c.reported_met).length}/${g.criteria.filter((c) => c.verified).length}/${g.criteria.length}`;
const stateCell = (g: Goal) => (g.paused_at ? `${g.state} (paused)` : g.blocked_reason ? `${g.state} (${g.blocked_reason})` : g.state);

async function listGoals(ctx: Ctx, flags: Flags): Promise<number> {
  let goals: Goal[];
  try {
    goals = await api(ctx, () => listWorkspaceGoalRecords(ctx.projectId));
  } catch (err) {
    if (unreachable(err)) return listLocal(undefined, flags.json);
    throw err;
  }
  if (flags.json) {
    emitJson({ goals, source: 'api' });
    return 0;
  }
  if (!goals.length) {
    process.stdout.write(`  ${C.dim}No goals you can read. A person creates one from the Goals page.${C.reset}\n`);
    return 0;
  }
  const w = Math.max(...goals.map((g) => g.slug.length), 4);
  process.stdout.write(`\n  ${C.dim}${pad('GOAL', w)}  ${pad('STATE', 22)}  ${pad('MET/VERIFIED/ALL', 16)}  NEXT WAKE${C.reset}\n`);
  for (const g of goals) process.stdout.write(`  ${pad(g.slug, w)}  ${pad(stateCell(g), 22)}  ${pad(criteriaCell(g), 16)}  ${g.next_wake_at ?? '—'}\n`);
  process.stdout.write('\n');
  return 0;
}

async function goalStatus(ctx: Ctx, ref: string | undefined, flags: Flags): Promise<number> {
  let g: Goal;
  try {
    g = await findGoal(ctx, ref, flags.goal);
  } catch (err) {
    if (unreachable(err)) return listLocal(ref, flags.json);
    throw err;
  }
  if (flags.json) {
    emitJson({ goal: g, source: 'api' });
    return 0;
  }
  const row = (k: string, v: string) => process.stdout.write(`  ${C.dim}${pad(k, 9)}${C.reset}${v}\n`);
  process.stdout.write(`\n  ${C.bold}${g.title}${C.reset}\n  ${C.dim}${g.folder} · ${g.goal_id}${C.reset}\n\n`);
  row('state', `${g.state}${g.paused_at ? ` (paused by a person ${g.paused_at})` : ''}${g.blocked_reason ? ` (blocked: ${g.blocked_reason})` : ''}`);
  row('revision', String(g.revision));
  row('owner', g.owner_session_id ?? '—');
  if (g.verification) row('verifier', `${g.verification.verifier_session_id} (attempt ${g.verification.attempt}, ${g.verification.outcome})`);
  row('wakes', `${g.wakes_today}/${g.max_wakes_per_day} today, every ${g.heartbeat_every}, next ${g.next_wake_at ?? '—'}`);
  row('sessions', `${g.sessions.length}/${g.max_sessions}`);
  if (g.provenance === 'legacy_unverified') row('note', 'imported from a folder: no criterion was verified by the API');
  process.stdout.write(`\n  ${C.dim}Criteria (revision ${g.criteria_revision}):${C.reset}\n`);
  for (const c of g.criteria) {
    const mark = c.verified ? 'verified' : c.reported_met ? 'reported met' : 'open';
    process.stdout.write(`  ${pad(c.id, 4)} ${pad(mark, 13)} ${c.text}${c.evidence ? ` ${C.dim}(${c.evidence})${C.reset}` : ''}\n`);
  }
  if (g.waiting_on) process.stdout.write(`\n  ${C.dim}Waiting on the assigned user:${C.reset} ${g.waiting_on}${g.chase_at ? ` ${C.dim}(chase ${g.chase_at})${C.reset}` : ''}\n`);
  if (g.summary) process.stdout.write(`\n  ${g.summary}\n`);
  process.stdout.write('\n');
  return 0;
}

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

/**
 * The API could not be reached: list the mounted folders, marked unverified.
 * Only the brief is read (title, criteria text); no lifecycle field and no
 * mirror block, because any session can write those.
 */
function listLocal(ref: string | undefined, json: boolean): number {
  const goals = goalFolders()
    .filter((f) => !ref || f.endsWith(`/${ref}`))
    .map((folder) => {
      let title = folder.split('/').pop()!;
      let criteria: string[] = [];
      try {
        const text = existsSync(join(folder, 'GOAL.md')) ? readFileSync(join(folder, 'GOAL.md'), 'utf8') : '';
        title = parseGoalFile(text)?.objective ?? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? title;
        criteria = briefCriteria(text);
      } catch {}
      return { folder, slug: folder.split('/').pop()!, title, criteria, state: 'unknown' as const };
    });
  if (json) {
    emitJson({ goals, source: 'unverified_local_copy' });
    return 0;
  }
  process.stdout.write(`  ${C.dim}Unverified local copy: the Goals API did not answer. State, owner and verification are unknown.${C.reset}\n`);
  if (!goals.length) process.stdout.write(`  ${C.dim}No goal folders under ${drivesRoot()}.${C.reset}\n`);
  for (const g of goals) {
    process.stdout.write(`  ${pad(g.slug, 24)}  ${g.title}  ${C.dim}(${g.criteria.length} criteria in GOAL.md)${C.reset}\n`);
  }
  return 0;
}
