/**
 * `kortix tasks` — the shared task list of an agent team (flag `agent_teams`).
 *
 * A team is one lead session and the teammates it started (child sessions
 * whose metadata `team_lead` names the lead). The list belongs to the lead:
 * every route is `/projects/:id/sessions/:lead/tasks`
 * (`@kortix/api-contract/multi-agent`). The server numbers tasks per team,
 * keeps `blocked` true while a task in `blocked_by` is open, and makes a claim
 * atomic: the loser of a race gets `409 task_taken`.
 */
import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  expandSessionIdPrefix,
  fail,
  missing,
  resolveProjectContext,
  SESSION_UUID_RE,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { machineErrors, writeMachineError } from '../token-denial.ts';
import { C, help, pad, status } from '../style.ts';

type TaskStatus = 'pending' | 'in_progress' | 'completed';
const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed'];

export interface SessionTask {
  seq: number;
  lead_session_id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner_handle: string | null;
  owner_session_id: string | null;
  blocked_by: number[];
  blocked: boolean;
  created_at: string;
  updated_at: string;
}

const SUBCOMMANDS = ['ls', 'add', 'claim', 'done', 'update', 'rm'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export const TASKS_HELP = help`Usage: kortix tasks [<lead-session>] <subcommand> [options]

The shared task list of an agent team: one lead session and the teammates it
started. The lead adds tasks; a teammate claims the next open one, works it
and marks it done. A task that waits for others (--blocked-by) shows as
blocked until they are done, and nobody can claim it meanwhile.

<lead-session> is the lead's session id or 8+ characters of it. Inside a
session it defaults to this session's lead ($KORTIX_SESSION_ID, or the lead
named in its team_lead metadata).

Needs the \`agent_teams\` feature flag (\`kortix projects features enable agent_teams\`).

Subcommands:
  ls                  Every task: number, state, owner, what it waits for.
  add "<subject>"     Add a task. --description "<text>", --blocked-by 1,2,
                      --owner <teammate handle>.
  claim <n>           Take task #n for this session. Only a pending, unowned,
                      unblocked task; when another session took it first,
                      exit 3.
  done <n>            Mark task #n completed. Tasks waiting for it unblock.
  update <n>          Change task #n: --status pending|in_progress|completed,
                      --owner <handle>, --release (no owner), --subject,
                      --description, --blocked-by 1,2 (adds to the list).
  rm <n>              Delete task #n.

Options:
  --project <id>      Project of the team (default: linked).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output.
  -h, --help          Show this help.

Exit codes: 0 ok, 1 API error, 2 usage error, 3 the task is taken or blocked.

Examples:
  kortix tasks add "Draft the outline" --owner writer
  kortix tasks add "Review the draft" --blocked-by 1
  kortix tasks 3f2a1b9c ls
  kortix tasks claim 2
  kortix tasks done 2
`;

interface Flags {
  json: boolean;
  projectArg?: string;
  hostArg?: string;
  description?: string;
  blockedBy?: string;
  owner?: string;
  release: boolean;
  status?: string;
  subject?: string;
}

function takeTaskFlags(rest: string[]): Flags {
  return {
    json: takeFlagBool(rest, ['--json']),
    projectArg: takeFlagValue(rest, ['--project']),
    hostArg: takeFlagValue(rest, ['--host']),
    description: takeFlagValue(rest, ['--description']),
    blockedBy: takeFlagValue(rest, ['--blocked-by']),
    owner: takeFlagValue(rest, ['--owner']),
    release: takeFlagBool(rest, ['--release']),
    status: takeFlagValue(rest, ['--status']),
    subject: takeFlagValue(rest, ['--subject']),
  };
}

/** `1,2,#3` → [1, 2, 3]; a non-number is a usage error. */
export function parseTaskNumbers(raw: string): number[] | string {
  const out: number[] = [];
  for (const part of raw.split(',').map((p) => p.trim().replace(/^#/, '')).filter(Boolean)) {
    if (!/^[1-9]\d*$/.test(part)) return `"${part}" is not a task number.`;
    out.push(Number(part));
  }
  return out.length ? out : 'Pass at least one task number.';
}

function taskNumber(raw: string | undefined): number | string {
  if (!raw) return 'Pass the task number (#n from kortix tasks ls).';
  const parsed = parseTaskNumbers(raw);
  if (typeof parsed === 'string') return parsed;
  return parsed.length === 1 ? parsed[0]! : 'Pass one task number.';
}

async function resolveLead(client: ApiClient, projectId: string, ref: string | undefined): Promise<string | number> {
  if (ref) {
    if (SESSION_UUID_RE.test(ref)) return ref;
    if (ref.length < 8) return fail(`"${ref}" is too short: pass the lead's session id or 8+ characters of it.`);
    const found = await expandSessionIdPrefix(client, projectId, ref);
    if (found === 'ambiguous') return fail(`"${ref}" matches more than one session: pass more characters.`);
    if (!found) {
      process.stderr.write(`${status.err(`No session ${ref} in project ${projectId}.`)}\n`);
      return 1;
    }
    return found.session_id;
  }
  const self = process.env.KORTIX_SESSION_ID;
  if (!self) return fail('Pass the lead session: kortix tasks <lead-session> <subcommand>. Outside a session there is no default team.');
  try {
    const session = await client.get<{ team_lead_session_id?: string | null; metadata?: Record<string, unknown> }>(
      `/projects/${projectId}/sessions/${self}`,
    );
    const lead = session.team_lead_session_id ?? session.metadata?.team_lead;
    return typeof lead === 'string' && lead ? lead : self;
  } catch (err) {
    return surfaceApiError(err);
  }
}

export async function runTasks(argv: string[]): Promise<number> {
  const helped = splitHelp(argv, TASKS_HELP);
  if (helped !== null) return helped;
  const rest = [...argv];
  let flags: Flags;
  try {
    flags = takeTaskFlags(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((a) => a.startsWith('-'));
  if (unknown) return fail(`Unknown option ${unknown}. Run kortix tasks --help.`);
  const leadRef = SUBCOMMANDS.includes(rest[0] as Sub) ? undefined : rest.shift();
  const sub = rest.shift() as Sub | undefined;
  if (!sub) return missing(`a subcommand: ${SUBCOMMANDS.join(', ')}`);
  if (!SUBCOMMANDS.includes(sub)) return fail(`Unknown subcommand "${sub}". Run kortix tasks --help.`);

  // Validate every argument before any request.
  let body: Record<string, unknown> | undefined;
  let seq: number | undefined;
  if (sub === 'add') {
    const subject = rest.join(' ').trim();
    if (!subject) return missing('the task subject: kortix tasks add "<subject>"');
    body = { subject };
    if (flags.description !== undefined) body.description = flags.description;
    if (flags.owner) body.owner = flags.owner;
    if (flags.blockedBy !== undefined) {
      const blocked = parseTaskNumbers(flags.blockedBy);
      if (typeof blocked === 'string') return fail(`--blocked-by: ${blocked}`);
      body.blocked_by = blocked;
    }
  } else if (sub !== 'ls') {
    const n = taskNumber(rest.shift());
    if (typeof n === 'string') return fail(n);
    seq = n;
    if (rest.length > 0) return fail(`Unexpected argument ${rest[0]}. Run kortix tasks --help.`);
    if (sub === 'claim') body = { claim: true };
    if (sub === 'done') body = { status: 'completed' };
    if (sub === 'update') {
      body = {};
      if (flags.status !== undefined) {
        if (!STATUSES.includes(flags.status as TaskStatus)) return fail(`--status is one of ${STATUSES.join(', ')}.`);
        body.status = flags.status;
      }
      if (flags.owner && flags.release) return fail('Pass --owner or --release, not both.');
      if (flags.owner) body.owner = flags.owner;
      if (flags.release) body.owner = null;
      if (flags.subject !== undefined) body.subject = flags.subject;
      if (flags.description !== undefined) body.description = flags.description;
      if (flags.blockedBy !== undefined) {
        const blocked = parseTaskNumbers(flags.blockedBy);
        if (typeof blocked === 'string') return fail(`--blocked-by: ${blocked}`);
        body.add_blocked_by = blocked;
      }
      if (Object.keys(body).length === 0) return fail('Nothing to update. Pass --status, --owner, --release, --subject, --description or --blocked-by.');
    }
  } else if (rest.length > 0) {
    return fail(`Unexpected argument ${rest[0]}. Run kortix tasks --help.`);
  }

  const ctx = await resolveProjectContext({ projectArg: flags.projectArg, hostArg: flags.hostArg });
  if (!ctx) return 1;
  const lead = await resolveLead(ctx.client, ctx.projectId, leadRef);
  if (typeof lead === 'number') return lead;
  const base = `/projects/${ctx.projectId}/sessions/${lead}/tasks`;

  try {
    if (sub === 'ls') {
      const { tasks } = await ctx.client.get<{ tasks: SessionTask[] }>(base);
      if (flags.json) emitJson({ tasks });
      else printTasks(tasks);
      return 0;
    }
    if (sub === 'add') {
      const task = await ctx.client.post<SessionTask>(base, body);
      if (flags.json) emitJson(task);
      else process.stdout.write(`${status.ok(`Added ${taskLine(task)}`)}\n`);
      return 0;
    }
    if (sub === 'rm') {
      await ctx.client.delete(`${base}/${seq}`);
      if (flags.json) emitJson({ seq, deleted: true });
      else process.stdout.write(`${status.ok(`Deleted #${seq}`)}\n`);
      return 0;
    }
    const task = await ctx.client.patch<SessionTask>(`${base}/${seq}`, body);
    if (flags.json) emitJson(task);
    else process.stdout.write(`${status.ok(`${sub === 'claim' ? 'Claimed' : sub === 'done' ? 'Done' : 'Updated'} ${taskLine(task)}`)}\n`);
    return 0;
  } catch (err) {
    return conflict(err, seq, flags.json) ?? surfaceApiError(err);
  }
}

/** `409 task_taken | task_blocked` is an answer, not a failure of the CLI: exit 3. */
function conflict(err: unknown, seq: number | undefined, json: boolean): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = (err.body ?? {}) as { code?: string; message?: string };
  if (body.code !== 'task_taken' && body.code !== 'task_blocked') return null;
  const message =
    body.message ||
    (body.code === 'task_taken' ? `Task #${seq} is already taken. Run kortix tasks ls and claim another.` : `Task #${seq} waits for other tasks.`);
  if (json) emitJson({ error: true, code: body.code, message });
  if (machineErrors()) writeMachineError({ kind: 'failed', status: 409, code: body.code, message });
  else process.stderr.write(`${status.warn(message)}\n`);
  return 3;
}

const STATE_LABEL: Record<TaskStatus, string> = { pending: 'pending', in_progress: 'working', completed: 'done' };

function taskLine(t: SessionTask): string {
  const owner = t.owner_handle ? ` ${C.cyan}@${t.owner_handle}${C.reset}` : '';
  return `${C.bold}#${t.seq}${C.reset} ${t.subject}${owner}`;
}

function printTasks(tasks: SessionTask[]): void {
  if (tasks.length === 0) {
    process.stdout.write(`  ${C.dim}No tasks yet. Add one: kortix tasks add "<subject>"${C.reset}\n`);
    return;
  }
  const open = tasks.filter((t) => t.status !== 'completed').length;
  process.stdout.write(`\n  ${C.dim}${tasks.length} tasks · ${open} open${C.reset}\n\n`);
  const ownerW = Math.max(5, ...tasks.map((t) => (t.owner_handle ? t.owner_handle.length + 1 : 1)));
  for (const t of [...tasks].sort((a, b) => a.seq - b.seq)) {
    const state = t.status === 'completed' ? `${C.green}done${C.reset}` : t.blocked ? `${C.yellow}blocked${C.reset}` : STATE_LABEL[t.status];
    const owner = t.owner_handle ? `@${t.owner_handle}` : '—';
    const waits = t.blocked && t.blocked_by.length ? `  ${C.dim}waits for ${t.blocked_by.map((n) => `#${n}`).join(', ')}${C.reset}` : '';
    process.stdout.write(`  ${pad(`#${t.seq}`, 4)}  ${pad(state, 8)}  ${pad(owner, ownerW)}  ${t.subject}${waits}\n`);
  }
  process.stdout.write('\n');
}
