import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import {
  type AgiGoal,
  type AgiGoalDetailResponse,
  type AgiGoalListResponse,
  type AgiGoalPushResponse,
  type AgiManifestIssue,
  renderTaskTable,
  surfaceConflict,
} from './tasks.ts';

const HELP = help`Usage: kortix goals <subcommand> [options]

Read the [[goals]] declared in your project's kortix.yaml and push them.
Goals are AUTHORED state — create or edit one by editing kortix.yaml and
running \`kortix ship\`, never from here. \`push\` fires the goal's cron
trigger now, through the ordinary trigger subsystem.

Subcommands:
  ls [--status <s>]        List goals + their open task counts.
  show <slug>              One goal in full, with its open tasks.
  push <slug>              Fire the goal's push trigger now.

List options:
  --status <status>        active|achieved|paused|abandoned.

Push options:
  --reason <text>          Why you're pushing — recorded on the session.

Exit codes:
  0                        Success.
  1                        API or network failure.
  2                        Usage error.
  3                        Conflict — the goal declares no push, or isn't
                           active. Nothing to retry.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <url>       Operate against this host (default: linked/active).
  -h, --help         Show this help.
`;

export async function runGoals(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // Without this a bare `--help` reaches the switch as a positional and
  // `goals show --help` looks up a goal literally named "--help".
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  let json = false;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let statusFlag: string | undefined;
  let reasonFlag: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    statusFlag = takeFlagValue(rest, ['--status']);
    reasonFlag = takeFlagValue(rest, ['--reason']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (sub) {
    case 'ls':
    case 'list':
      return goalsLs(ctxOpts, statusFlag, json);
    case 'show':
    case 'info':
      return goalsShow(positional[0], ctxOpts, json);
    case 'push':
    case 'fire':
      return goalsPush(positional[0], ctxOpts, reasonFlag, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

const GOAL_STATUSES = ['active', 'achieved', 'paused', 'abandoned'];

async function goalsLs(
  opts: CtxOpts,
  statusFlag: string | undefined,
  json = false,
): Promise<number> {
  let query: string;
  try {
    query = buildGoalListQuery(statusFlag);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiGoalListResponse;
  try {
    resp = await ctx.client.get<AgiGoalListResponse>(
      `/projects/${ctx.projectId}/agi/goals${query}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  if (resp.goals.length === 0) {
    process.stdout.write(`${status.info('No goals.')}\n`);
  } else {
    process.stdout.write(`\n${renderGoalTable(resp.goals)}`);
    process.stdout.write(
      `\n  ${C.dim}${resp.goals.length} goal${resp.goals.length === 1 ? '' : 's'}${C.reset}\n\n`,
    );
  }

  // A malformed manifest entry is reported, never fatal — `kortix validate` is
  // the gate for the manifest, not this read.
  for (const issue of resp.errors) {
    process.stdout.write(`${status.warn(formatGoalIssue(issue))}\n`);
  }
  return 0;
}

async function goalsShow(
  slug: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a goal slug.')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiGoalDetailResponse;
  try {
    resp = await ctx.client.get<AgiGoalDetailResponse>(
      `/projects/${ctx.projectId}/agi/goals/${encodeURIComponent(slug)}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  const g = resp.goal;
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${g.title}${C.reset}\n`);
  const line = (key: string, value: string) =>
    process.stdout.write(`  ${C.dim}${pad(key, 10)}${C.reset}${value}\n`);
  line('slug', g.slug);
  line('status', g.status);
  line('agent', g.agent ?? '—');
  line('push', g.push ?? '—');
  line('trigger', g.trigger_slug ?? '—');

  process.stdout.write(`\n  ${C.white}${C.bold}Done when:${C.reset}\n  ${g.done_when}\n`);

  if (resp.open_tasks.length > 0) {
    process.stdout.write(`\n${renderTaskTable(resp.open_tasks)}`);
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.open_tasks.length} open task${resp.open_tasks.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function goalsPush(
  slug: string | undefined,
  opts: CtxOpts,
  reason: string | undefined,
  json = false,
): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a goal slug.')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiGoalPushResponse;
  try {
    resp = await ctx.client.post<AgiGoalPushResponse>(
      `/projects/${ctx.projectId}/agi/goals/${encodeURIComponent(slug)}/push`,
      { reason: reason ?? null },
    );
  } catch (err) {
    return surfaceConflict(err, json) ?? surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  process.stdout.write(`${status.ok(`pushed ${slug}  session ${resp.session_id}`)}\n`);
  return 0;
}

// ── Exported helpers (pure — unit-tested directly) ──────────────────────────

export function buildGoalListQuery(statusFilter?: string): string {
  if (!statusFilter) return '';
  if (!GOAL_STATUSES.includes(statusFilter)) {
    throw new Error(`--status must be one of ${GOAL_STATUSES.join(', ')}`);
  }
  return `?status=${encodeURIComponent(statusFilter)}`;
}

export function formatGoalIssue(issue: AgiManifestIssue): string {
  return `goal[${issue.index}]${issue.slug ? ` ${issue.slug}` : ''}: ${issue.message}`;
}

export function renderGoalTable(goals: AgiGoal[]): string {
  const slugW = Math.max(...goals.map((g) => g.slug.length), 4);
  const statusW = Math.max(...goals.map((g) => g.status.length), 6);
  const pushW = Math.max(...goals.map((g) => (g.push ?? '-').length), 4);
  const openW = Math.max(...goals.map((g) => String(g.open_task_count).length), 4);

  const rows = [
    `  ${C.dim}${pad('SLUG', slugW)}   ${pad('STATUS', statusW)}   ${pad('PUSH', pushW)}   ${pad('OPEN', openW)}   TITLE${C.reset}`,
  ];
  for (const g of goals) {
    rows.push(
      `  ${pad(g.slug, slugW)}   ${pad(g.status, statusW)}   ${pad(g.push ?? '-', pushW)}   ${pad(String(g.open_task_count), openW)}   ${g.title}`,
    );
  }
  return `${rows.join('\n')}\n`;
}
