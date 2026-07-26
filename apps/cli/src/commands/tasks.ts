import { ApiError } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// ── Wire types ──────────────────────────────────────────────────────────────
// Field names track the AGI HTTP contract 1:1 (snake_case) so `--json` output
// is the API response byte-for-byte and agents can parse either interchangeably.
// They live here rather than in api/types.ts while `agi` is experimental — the
// whole surface moves together, and goals.ts imports them from this module.

export interface AgiTask {
  task_id: string;
  workspace_id: string;
  parent_id: string | null;
  goal_slug: string | null;
  project: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  agent: string | null;
  assignee_user_id: string | null;
  blocked_by: string[];
  trigger_slug: string | null;
  claim_session_id: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claimed: boolean;
  origin: string;
  origin_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgiGoal {
  slug: string;
  title: string;
  done_when: string;
  status: string;
  push: string | null;
  agent: string | null;
  trigger_slug: string | null;
  open_task_count: number;
  task_counts: Record<string, number>;
}

export interface AgiManifestIssue {
  index: number;
  slug: string | null;
  message: string;
}

export interface AgiTaskListResponse {
  tasks: AgiTask[];
  next_cursor: string | null;
}

export interface AgiTaskDetailResponse {
  task: AgiTask;
  children: AgiTask[];
  blockers: AgiTask[];
  missing_blockers: string[];
}

export interface AgiTaskCreateResponse {
  task: AgiTask;
  created: boolean;
}

export interface AgiTaskMutateResponse {
  task: AgiTask;
  claimed?: boolean;
  released?: boolean;
}

export interface AgiGoalListResponse {
  goals: AgiGoal[];
  errors: AgiManifestIssue[];
}

export interface AgiGoalDetailResponse {
  goal: AgiGoal;
  open_tasks: AgiTask[];
}

export interface AgiGoalPushResponse {
  session_id: string;
  trigger_slug: string;
}

const HELP = help`Usage: kortix tasks <subcommand> [options]

Work the AGI task queue for the linked workspace — the shared board sessions
claim work from. Tasks live in the cloud (not kortix.yaml); goals do the
opposite. Every subcommand takes --json for machine-readable output.

Open work is listed priority-first and then OLDEST first, so a task nobody has
finished rises toward the top instead of sinking under today's new ones. The
IDLE column is the time since the task last changed.

Subcommands:
  ls [options]             List tasks. Defaults to open ones.
  ready [options]          Work that can be started right now: open, every
                           blocker completed, claim free. Start here.
  show <task-id>           One task in full: blockers, children, body.
  new <title...>           Create a task.
  claim <task-id>          Take exclusive ownership for a session (atomic).
  done <task-id>           Close a task (also clears its claim).
  block <task-id>          Add/remove blockers (--on/--off).

List options:
  --ready                  Only startable work — same as the \`ready\`
                           subcommand. A CANCELLED blocker does not count as
                           satisfied, so its task stays out.
  --priority <list>        Comma-separated: urgent|high|medium|low.
  --idle <days>            Only tasks untouched for that many days.
  --status <list>          Comma-separated statuses, or \`open\`/\`all\`
                           (default open).
  --goal <slug>            Filter by goal slug, or \`none\`.
  --label <name>           Filter by the task's grouping label, or \`none\`.
                           Named --label because --project is the workspace.
  --assignee <spec>        agent:<name> | user:<uuid> | none | any.
  --parent <task-id>       Children of this task, or \`none\` for roots.
  --blocked-by <task-id>   Tasks blocked on this one.
  --trigger <slug>         Filter by trigger slug.
  --claim <free|held>      Only unclaimed, or only actively claimed, tasks.
  --limit <n>              1..200 (default 50).

New options:
  --body <text>            Long-form description.
  --goal <slug>            Goal this task advances.
  --label <name>           Grouping label.
  --parent <task-id>       Parent task (structure, NOT a dependency).
  --priority <level>       urgent|high|medium|low (default medium).
  --status <status>        Initial status (default backlog).
  --agent <name>           Assign to an agent.
  --assignee-user <uuid>   Assign to a human. Mutually exclusive with --agent.
  --blocked-by <task-id>   Blocker (repeatable).
  --trigger <slug>         Trigger this task belongs to.
  --origin <origin>        human|agi|session|trigger (default human).
  --fingerprint <string>   Idempotency key — a second create with the same
                           fingerprint returns the existing task.

Claim options:
  --session <id>           Claiming session (default $KORTIX_SESSION_ID).
  --ttl <seconds>          Lease length, 30..86400 (default 900).
  --doing                  Also set status = doing, in the same atomic claim.
  --review                 Also set status = review.

Done options:
  --as <status>            done|cancelled|review (default done).

Block options:
  --on <task-id>           Blocker to add (repeatable).
  --off <task-id>          Blocker to remove (repeatable).
  --keep-status            Don't auto-move the task to blocked/todo.

Exit codes:
  0                        Success.
  1                        API or network failure.
  2                        Usage error.
  3                        Conflict — another session owns the claim. Pick
                           different work; do NOT retry the same claim.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <url>       Operate against this host (default: linked/active).
  -h, --help         Show this help.
`;

const DONE_STATUSES = ['done', 'cancelled', 'review'];

export async function runTasks(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // No subcommand below owns its own flag parsing, so without this a bare
  // `--help` falls through as a positional — `tasks show --help` would look up
  // a task literally named "--help".
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  let json = false;
  let keepStatus = false;
  let doing = false;
  let review = false;
  let ready = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  const f: Record<string, string | undefined> = {};
  let blockedBy: string[] = [];
  let on: string[] = [];
  let off: string[] = [];
  try {
    json = takeFlagBool(rest, ['--json']);
    keepStatus = takeFlagBool(rest, ['--keep-status']);
    doing = takeFlagBool(rest, ['--doing']);
    review = takeFlagBool(rest, ['--review']);
    ready = takeFlagBool(rest, ['--ready']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    f.status = takeFlagValue(rest, ['--status']);
    f.goal = takeFlagValue(rest, ['--goal']);
    f.label = takeFlagValue(rest, ['--label']);
    f.assignee = takeFlagValue(rest, ['--assignee']);
    f.assigneeUser = takeFlagValue(rest, ['--assignee-user']);
    f.parent = takeFlagValue(rest, ['--parent']);
    f.trigger = takeFlagValue(rest, ['--trigger']);
    f.claim = takeFlagValue(rest, ['--claim']);
    f.idle = takeFlagValue(rest, ['--idle']);
    f.limit = takeFlagValue(rest, ['--limit']);
    f.body = takeFlagValue(rest, ['--body']);
    f.priority = takeFlagValue(rest, ['--priority']);
    f.agent = takeFlagValue(rest, ['--agent']);
    f.origin = takeFlagValue(rest, ['--origin']);
    f.fingerprint = takeFlagValue(rest, ['--fingerprint']);
    f.session = takeFlagValue(rest, ['--session']);
    f.ttl = takeFlagValue(rest, ['--ttl']);
    f.as = takeFlagValue(rest, ['--as']);
    // Repeatable on `new`; `ls` uses only the first occurrence as a filter.
    blockedBy = takeFlagValues(rest, ['--blocked-by']);
    on = takeFlagValues(rest, ['--on']);
    off = takeFlagValues(rest, ['--off']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };
  const positional = rest.filter((a) => !a.startsWith('-'));

  const listFilters: TaskListFilters = {
    status: f.status,
    priority: f.priority,
    ready,
    idle: f.idle,
    goal: f.goal,
    label: f.label,
    assignee: f.assignee,
    parent: f.parent,
    blockedBy: blockedBy[0],
    trigger: f.trigger,
    claim: f.claim,
    limit: f.limit,
  };

  switch (sub) {
    case 'ls':
    case 'list':
      return tasksLs(ctxOpts, listFilters, json);
    // The daily push's entry point: `ready` is `ls --ready`, named so the one
    // query that finds startable work does not depend on remembering a flag.
    case 'ready':
      return tasksLs(ctxOpts, { ...listFilters, ready: true }, json);
    case 'show':
    case 'info':
      return tasksShow(positional[0], ctxOpts, json);
    case 'new':
    case 'create':
    case 'add':
      return tasksNew(positional.join(' '), ctxOpts, { ...f, blockedBy }, json);
    case 'claim':
      return tasksClaim(positional[0], ctxOpts, f.session, f.ttl, doing, review, json);
    case 'done':
    case 'close':
      return tasksDone(positional[0], ctxOpts, f.as, json);
    case 'block':
      return tasksBlock(positional[0], ctxOpts, on, off, keepStatus, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

// ── Subcommands ─────────────────────────────────────────────────────────────

async function tasksLs(opts: CtxOpts, filters: TaskListFilters, json = false): Promise<number> {
  let query: string;
  try {
    query = buildTaskListQuery(filters);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiTaskListResponse;
  try {
    resp = await ctx.client.get<AgiTaskListResponse>(
      `/projects/${ctx.projectId}/agi/tasks${query}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  if (resp.tasks.length === 0) {
    // An empty ready view is ambiguous in a way an empty list is not: it means
    // either nothing is open OR everything open is waiting on something. Saying
    // "No tasks." would read as an empty board.
    process.stdout.write(
      `${status.info(
        filters.ready
          ? 'No ready work (nothing open, or every open task is blocked or claimed).'
          : 'No tasks.',
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`\n${renderTaskTable(resp.tasks)}`);
  const more = resp.next_cursor ? '  (more available)' : '';
  process.stdout.write(
    `\n  ${C.dim}${resp.tasks.length} task${resp.tasks.length === 1 ? '' : 's'}${more}${C.reset}\n\n`,
  );
  return 0;
}

async function tasksShow(
  taskId: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  const id = requireTaskIdArg(taskId);
  if (id === null) return 2;
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiTaskDetailResponse;
  try {
    resp = await ctx.client.get<AgiTaskDetailResponse>(
      `/projects/${ctx.projectId}/agi/tasks/${id}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  const t = resp.task;
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${t.title}${C.reset}\n`);
  const line = (key: string, value: string) =>
    process.stdout.write(`  ${C.dim}${pad(key, 10)}${C.reset}${value}\n`);
  line('id', t.task_id);
  line('status', t.status);
  line('priority', t.priority);
  line('assignee', assigneeLabel(t));
  line('goal', t.goal_slug ?? '—');
  line('label', t.project ?? '—');
  line('parent', t.parent_id ?? '—');
  line('trigger', t.trigger_slug ?? '—');
  line('origin', t.origin);
  line('created', t.created_at);
  line('idle', `${formatAge(t.updated_at)} (last change ${t.updated_at})`);
  line(
    'claim',
    t.claim_session_id
      ? `claimed by ${t.claim_session_id} until ${t.claim_expires_at ?? '—'}`
      : 'unclaimed',
  );

  if (t.blocked_by.length > 0) {
    process.stdout.write(`\n  ${C.white}${C.bold}BLOCKED BY${C.reset}\n`);
    for (const blockerId of t.blocked_by) {
      const blocker = resp.blockers.find((b) => b.task_id === blockerId);
      process.stdout.write(
        blocker
          ? `    ${shortId(blocker.task_id)}  ${pad(blocker.status, 9)}  ${blocker.title}\n`
          : `    ${shortId(blockerId)}  ${C.faded}(missing)${C.reset}\n`,
      );
    }
  }

  if (resp.children.length > 0) {
    process.stdout.write(`\n  ${C.white}${C.bold}CHILDREN${C.reset}\n\n${renderTaskTable(resp.children)}`);
  }

  if (t.body) process.stdout.write(`\n${t.body}\n`);
  process.stdout.write('\n');
  return 0;
}

async function tasksNew(
  title: string,
  opts: CtxOpts,
  f: Record<string, unknown>,
  json = false,
): Promise<number> {
  if (!title.trim()) {
    process.stderr.write(`${status.err('Pass a task title.')}\n`);
    return 2;
  }
  // R-14 is a DB CHECK, but catching it here keeps the failure a usage error
  // with no round trip instead of a 400 the caller has to interpret.
  if (f.agent && f.assigneeUser) {
    process.stderr.write(`${status.err('A task has at most one assignee.')}\n`);
    return 2;
  }
  const body: Record<string, unknown> = {
    title: title.trim(),
    origin: (f.origin as string | undefined) ?? 'human',
    priority: (f.priority as string | undefined) ?? 'medium',
    status: (f.status as string | undefined) ?? 'backlog',
  };
  try {
    if (f.body) body.body = f.body;
    if (f.goal) body.goal_slug = f.goal;
    if (f.label) body.project = f.label;
    if (f.parent) body.parent_id = requireTaskId(f.parent as string);
    if (f.agent) body.agent = f.agent;
    if (f.assigneeUser) {
      if (!UUID_RE.test(f.assigneeUser as string)) throw new Error('--assignee-user must be a uuid');
      body.assignee_user_id = f.assigneeUser;
    }
    if (f.trigger) body.trigger_slug = f.trigger;
    if (f.fingerprint) body.origin_fingerprint = f.fingerprint;
    const blockers = (f.blockedBy as string[] | undefined) ?? [];
    if (blockers.length > 0) body.blocked_by = blockers.map(requireTaskId);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiTaskCreateResponse;
  try {
    resp = await ctx.client.post<AgiTaskCreateResponse>(
      `/projects/${ctx.projectId}/agi/tasks`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  const label = `${shortId(resp.task.task_id)}  ${resp.task.title}`;
  process.stdout.write(
    resp.created
      ? `${status.ok(`created ${label}`)}\n`
      : `${status.info(`exists ${label}`)}\n`,
  );
  return 0;
}

async function tasksClaim(
  taskId: string | undefined,
  opts: CtxOpts,
  sessionFlag: string | undefined,
  ttlFlag: string | undefined,
  doing: boolean,
  review: boolean,
  json = false,
): Promise<number> {
  const id = requireTaskIdArg(taskId);
  if (id === null) return 2;
  if (doing && review) {
    process.stderr.write(`${status.err('Pass --doing or --review, not both.')}\n`);
    return 2;
  }
  const sessionId = sessionFlag ?? process.env.KORTIX_SESSION_ID;
  if (!sessionId) {
    process.stderr.write(`${status.err('--session is required outside a session.')}\n`);
    return 2;
  }
  let ttl: number | undefined;
  if (ttlFlag !== undefined) {
    ttl = Number(ttlFlag);
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) {
      process.stderr.write(`${status.err('--ttl must be an integer between 30 and 86400.')}\n`);
      return 2;
    }
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const body: Record<string, unknown> = { session_id: sessionId };
  if (ttl !== undefined) body.ttl_seconds = ttl;
  if (doing) body.status = 'doing';
  if (review) body.status = 'review';

  let resp: AgiTaskMutateResponse;
  try {
    resp = await ctx.client.post<AgiTaskMutateResponse>(
      `/projects/${ctx.projectId}/agi/tasks/${id}/claim`,
      body,
    );
  } catch (err) {
    return surfaceConflict(err, json) ?? surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`claimed ${shortId(resp.task.task_id)}  expires ${resp.task.claim_expires_at ?? '—'}`)}\n`,
  );
  return 0;
}

async function tasksDone(
  taskId: string | undefined,
  opts: CtxOpts,
  asFlag: string | undefined,
  json = false,
): Promise<number> {
  const id = requireTaskIdArg(taskId);
  if (id === null) return 2;
  const as = asFlag ?? 'done';
  if (!DONE_STATUSES.includes(as)) {
    process.stderr.write(`${status.err(`--as must be one of ${DONE_STATUSES.join(', ')}.`)}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiTaskMutateResponse;
  try {
    resp = await ctx.client.patch<AgiTaskMutateResponse>(
      `/projects/${ctx.projectId}/agi/tasks/${id}`,
      { status: as },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${as} ${shortId(resp.task.task_id)}  ${resp.task.title}`)}\n`,
  );
  return 0;
}

// R-16. Read-modify-write on purpose: blocked_by isn't contended the way a
// claim is, so the edge set is a plain full replacement rather than a
// server-side array merge.
async function tasksBlock(
  taskId: string | undefined,
  opts: CtxOpts,
  on: string[],
  off: string[],
  keepStatus: boolean,
  json = false,
): Promise<number> {
  const id = requireTaskIdArg(taskId);
  if (id === null) return 2;
  if (on.length === 0 && off.length === 0) {
    process.stderr.write(`${status.err('Pass --on <task-id> and/or --off <task-id>.')}\n`);
    return 2;
  }
  try {
    on.forEach(requireTaskId);
    off.forEach(requireTaskId);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let current: AgiTaskDetailResponse;
  try {
    current = await ctx.client.get<AgiTaskDetailResponse>(
      `/projects/${ctx.projectId}/agi/tasks/${id}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const next = mergeBlockedBy(current.task.blocked_by, on, off);
  const body: Record<string, unknown> = { blocked_by: next };
  if (!keepStatus) {
    const nextStatus = blockedStatusChange(current.task.status, next);
    if (nextStatus) body.status = nextStatus;
  }

  let resp: AgiTaskMutateResponse;
  try {
    resp = await ctx.client.patch<AgiTaskMutateResponse>(
      `/projects/${ctx.projectId}/agi/tasks/${id}`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  const id8 = shortId(resp.task.task_id);
  process.stdout.write(
    on.length === 0 && next.length === 0
      ? `${status.ok(`unblocked ${id8}`)}\n`
      : `${status.ok(`blocked ${id8} on ${next.length} task${next.length === 1 ? '' : 's'}`)}\n`,
  );
  return 0;
}

// ── Exported helpers (pure — unit-tested directly) ──────────────────────────

export interface TaskListFilters {
  status?: string;
  priority?: string;
  ready?: boolean;
  idle?: string;
  goal?: string;
  label?: string;
  assignee?: string;
  parent?: string;
  blockedBy?: string;
  trigger?: string;
  claim?: string;
  limit?: string;
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are DISPLAYED truncated, so a truncated id coming back in is a paste
 *  mistake, not a lookup key — reject it here instead of 404ing server-side. */
export function requireTaskId(value: string): string {
  if (!UUID_RE.test(value)) throw new Error('pass the full task id');
  return value;
}

/** `--assignee` spec → the wire value, rejecting anything the API would 400 on. */
export function parseAssigneeSpec(spec: string): string {
  if (spec === 'none' || spec === 'any') return spec;
  if (spec.startsWith('agent:')) {
    if (spec.length <= 'agent:'.length) throw new Error('--assignee agent:<name> needs a name');
    return spec;
  }
  if (spec.startsWith('user:')) {
    requireTaskId(spec.slice('user:'.length));
    return spec;
  }
  throw new Error('--assignee must be agent:<name>, user:<uuid>, none, or any');
}

/** Build the `tasks ls` query string. `--label` maps to the API's `project`
 *  param; `--project` is the workspace flag and never reaches the query. */
export function buildTaskListQuery(f: TaskListFilters): string {
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.priority) {
    const bands = f.priority.split(',').map((part) => part.trim());
    if (bands.some((band) => !PRIORITIES.includes(band))) {
      throw new Error(`--priority must be one of ${PRIORITIES.join(', ')}`);
    }
    params.set('priority', bands.join(','));
  }
  // Only ever sent as `1`: the API rejects anything it cannot read as a
  // boolean, and an omitted param is what "not the ready view" means.
  if (f.ready) params.set('ready', '1');
  if (f.idle) {
    const days = Number(f.idle);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error('--idle must be a positive integer number of days');
    }
    params.set('idle_days', String(days));
  }
  if (f.goal) params.set('goal', f.goal);
  if (f.label) params.set('project', f.label);
  if (f.assignee) params.set('assignee', parseAssigneeSpec(f.assignee));
  if (f.parent) params.set('parent', f.parent === 'none' ? 'none' : requireTaskId(f.parent));
  if (f.blockedBy) params.set('blocked_by', requireTaskId(f.blockedBy));
  if (f.trigger) params.set('trigger', f.trigger);
  if (f.claim) {
    if (f.claim !== 'free' && f.claim !== 'held') {
      throw new Error('--claim must be free or held');
    }
    params.set('claim', f.claim);
  }
  if (f.limit) {
    const limit = Number(f.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('--limit must be an integer between 1 and 200');
    }
    params.set('limit', String(limit));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Full replacement set for `tasks block`: drop every --off, then append every
 *  --on that isn't already there. Existing order is preserved so the array
 *  stays stable across repeated edits. */
export function mergeBlockedBy(existing: string[], on: string[], off: string[]): string[] {
  const removed = new Set(off);
  const next: string[] = [];
  for (const id of existing) {
    if (removed.has(id) || next.includes(id)) continue;
    next.push(id);
  }
  // --on is applied after the removals, so an id passed to both ends up present.
  for (const id of on) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

/** The status `tasks block` should also write, or undefined to leave it alone.
 *  Terminal tasks are never re-opened by an edge change. */
export function blockedStatusChange(
  currentStatus: string,
  nextBlockedBy: string[],
): 'blocked' | 'todo' | undefined {
  if (nextBlockedBy.length > 0) {
    return ['done', 'cancelled', 'blocked'].includes(currentStatus) ? undefined : 'blocked';
  }
  return currentStatus === 'blocked' ? 'todo' : undefined;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function assigneeLabel(task: Pick<AgiTask, 'agent' | 'assignee_user_id'>): string {
  if (task.agent) return `@${task.agent}`;
  if (task.assignee_user_id) return `u:${shortId(task.assignee_user_id)}`;
  return '-';
}

/**
 * Time since `iso`, in one compact cell. Measured from `updated_at`, so it
 * answers the only question the queue cannot answer by ordering alone: has
 * anyone touched this at all? Sub-minute precision would be noise — a task is
 * interesting here at days, not seconds.
 */
export function formatAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The shared task table — `tasks ls`, `tasks show`'s children, and
 *  `goals show`'s open tasks all render identical columns. */
export function renderTaskTable(tasks: AgiTask[], now: Date = new Date()): string {
  const idW = 8;
  const age = new Map(tasks.map((t) => [t.task_id, formatAge(t.updated_at, now)]));
  const statusW = Math.max(...tasks.map((t) => t.status.length), 6);
  const priW = Math.max(...tasks.map((t) => t.priority.length), 3);
  const idleW = Math.max(...tasks.map((t) => age.get(t.task_id)!.length), 4);
  const asgW = Math.max(...tasks.map((t) => assigneeLabel(t).length), 8);
  const goalW = Math.max(...tasks.map((t) => (t.goal_slug ?? '-').length), 4);
  const fixed = 2 + idW + 3 + statusW + 3 + priW + 3 + idleW + 3 + asgW + 3 + goalW + 3;
  const titleW = Math.max(20, terminalWidth() - fixed);

  const rows = [
    `  ${C.dim}${pad('ID', idW)}   ${pad('STATUS', statusW)}   ${pad('PRI', priW)}   ${pad('IDLE', idleW)}   ${pad('ASSIGNEE', asgW)}   ${pad('GOAL', goalW)}   TITLE${C.reset}`,
  ];
  for (const t of tasks) {
    rows.push(
      `  ${pad(shortId(t.task_id), idW)}   ${pad(t.status, statusW)}   ${pad(t.priority, priW)}   ${pad(age.get(t.task_id)!, idleW)}   ${pad(assigneeLabel(t), asgW)}   ${pad(t.goal_slug ?? '-', goalW)}   ${truncate(t.title, titleW)}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

/** A 409 means the caller LOST a race (claim/release/push). Exit 3 keeps that
 *  distinguishable from a plain failure so a script can pick different work —
 *  and per R-18 it must never be retried. Returns null for anything else. */
export function surfaceConflict(err: unknown, json = false): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (json) {
    emitJson(err.body);
    return 3;
  }
  process.stderr.write(`${status.err(err.message)}\n`);
  return 3;
}

// ── Local helpers ───────────────────────────────────────────────────────────

/** Validate a positional task id, printing the usage error itself. Returns
 *  null when the caller should exit 2. */
function requireTaskIdArg(value: string | undefined): string | null {
  if (!value) {
    process.stderr.write(`${status.err('Pass a task id.')}\n`);
    return null;
  }
  if (!UUID_RE.test(value)) {
    process.stderr.write(`${status.err('pass the full task id')}\n`);
    return null;
  }
  return value;
}

function terminalWidth(): number {
  const cols = process.stdout.columns ?? 0;
  return cols > 40 ? cols : 100;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}
