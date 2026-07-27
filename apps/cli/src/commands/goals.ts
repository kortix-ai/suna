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
  type AgiGoalLiveness,
  type AgiGoalLivenessView,
  type AgiGoalMetric,
  type AgiGoalMetricSeries,
  type AgiGoalPushResponse,
  type AgiLivenessResponse,
  type AgiManifestIssue,
  type AgiObserveResponse,
  goalLivenessLabel,
  goalStallGuidance,
  renderTaskTable,
  surfaceConflict,
} from './tasks.ts';

const HELP = help`Usage: kortix goals <subcommand> [options]

Read the [[goals]] declared in your project's kortix.yaml, push them, and
record what they measure. Goals are AUTHORED state — create or edit one by
editing kortix.yaml and running \`kortix ship\`, never from here. \`push\`
fires the goal's cron trigger now, through the ordinary trigger subsystem.

\`observe\` is how "measurably advanced" stops being an opinion. There is no
signal to declare and no probe to register: a measurement is taken by an
ordinary cron trigger's session or an ordinary webhook's session, and that
session records it here. One verb, every producer.

\`ls\` and \`show\` carry the goal's LIVENESS — measuring, unmeasurable,
unquantified, or STALLED (every metric flat across N readings). A stalled goal
means work happened and the goal did not get closer; nothing sweeps it, and the
answer is a different move. \`kortix tasks stalled\` is the same question asked
about tasks.

Subcommands:
  ls [--status <s>]        List goals, their metrics, liveness, and open tasks.
  show <slug>              One goal in full, with its series and open tasks.
  push <slug>              Fire the goal's push trigger now.
  observe <slug>           Record one reading of one metric.

List options:
  --status <status>        active|achieved|paused|abandoned.

Push options:
  --reason <text>          Why you're pushing — recorded on the session.

Observe options:
  --metric <name>          What was measured. Lowercased, spaces folded to _,
                           so "Google Rank" and google_rank are one series.
  --value <number>         The reading. Must be a finite number.
  --source <text>          Who took it (default: this session).
  --at <iso>               When it was taken (default: now). For a webhook
                           relaying a reading that was taken earlier.

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
  let metricFlag: string | undefined;
  let valueFlag: string | undefined;
  let sourceFlag: string | undefined;
  let atFlag: string | undefined;
  try {
    json = takeFlagBool(rest, ['--json']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    statusFlag = takeFlagValue(rest, ['--status']);
    reasonFlag = takeFlagValue(rest, ['--reason']);
    metricFlag = takeFlagValue(rest, ['--metric']);
    valueFlag = takeFlagValue(rest, ['--value']);
    sourceFlag = takeFlagValue(rest, ['--source']);
    atFlag = takeFlagValue(rest, ['--at']);
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
    case 'observe':
    case 'record':
      return goalsObserve(
        positional[0],
        ctxOpts,
        { metric: metricFlag, value: valueFlag, source: sourceFlag, at: atFlag },
        json,
      );
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
  const liveness = await fetchLiveness(ctx);

  if (json) {
    // Additive: the goals response verbatim, plus the liveness verdict that
    // lives on a different route. A parser that only knows `goals` is
    // unaffected; one that wants to know whether anything is stuck reads
    // `liveness.stalled_total`.
    emitJson({ ...resp, liveness: liveness ?? null });
    return 0;
  }

  if (resp.goals.length === 0) {
    process.stdout.write(`${status.info('No goals.')}\n`);
  } else {
    process.stdout.write(`\n${renderGoalTable(resp.goals, livenessBySlug(liveness))}`);
    process.stdout.write(
      `\n  ${C.dim}${resp.goals.length} goal${resp.goals.length === 1 ? '' : 's'}${C.reset}\n`,
    );
    process.stdout.write(`${renderLivenessSummary(liveness)}\n`);
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
  const liveness = await fetchLiveness(ctx);
  const view = liveness?.goals.find((entry) => entry.slug === resp.goal.slug) ?? null;

  if (json) {
    emitJson({ ...resp, liveness: view?.liveness ?? null });
    return 0;
  }

  const g = resp.goal;
  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${g.title}${C.reset}\n`);
  const line = (key: string, value: string) =>
    process.stdout.write(`  ${C.dim}${pad(key, 10)}${C.reset}${value}\n`);
  line('slug', g.slug);
  line('status', g.status);
  // `status` is authored in kortix.yaml — it says what a human INTENDED. This
  // says what the series actually shows, which is the only one of the two that
  // can contradict a comfortable assumption.
  if (view) line('liveness', renderGoalLivenessCell(view.liveness));
  line('agent', g.agent ?? '—');
  line('push', g.push ?? '—');
  line('trigger', g.trigger_slug ?? '—');

  process.stdout.write(`\n  ${C.white}${C.bold}Done when:${C.reset}\n  ${g.done_when}\n`);

  // The whole point of §4.2: `done_when` above is prose, and this is the only
  // thing that can say whether it is being met. An UNMEASURABLE goal prints the
  // warning instead of a table, because an empty table reads as "fine".
  process.stdout.write(`\n  ${C.white}${C.bold}Metrics:${C.reset}\n`);
  if (resp.metric_series.length > 0) {
    process.stdout.write(renderMetricTable(resp.metric_series));
  } else {
    process.stdout.write(`  ${measurabilityNotice(g)}\n`);
  }

  // A goal whose every metric has flat-lined has a full metrics table above it
  // and is still not advancing. Without this the table reads as health.
  const notice = renderGoalStallNotice(view);
  if (notice) process.stdout.write(notice);

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
  process.stdout.write(`${renderPushResult(slug, resp)}\n`);
  return 0;
}

/**
 * A push is a trigger fire, so it has all three trigger outcomes and only one of
 * them has a session. Same shape `kortix triggers fire` renders, because it is
 * the same event reached through the goal.
 */
export function renderPushResult(slug: string, resp: AgiGoalPushResponse): string {
  const suffix = resp.reason ? `${C.dim} — ${resp.reason}${C.reset}` : '';
  if (resp.status === 'queued') {
    // No session id, and that is correct rather than missing: the prompt is on
    // the lifecycle queue and the session it lands on is chosen at delivery.
    const queued = resp.command_id ? `${C.dim} (command ${resp.command_id})${C.reset}` : '';
    return status.info(`queued ${C.bold}${slug}${C.reset}${queued}${suffix}`);
  }
  if (resp.status === 'deduped' || resp.deduped) {
    return status.info(`already pushed ${C.bold}${slug}${C.reset}${suffix}`);
  }
  const session = resp.session_id ? `  session ${C.dim}${resp.session_id}${C.reset}` : '';
  return status.ok(`pushed ${C.bold}${slug}${C.reset}${session}`);
}

/**
 * R-12c. THE verb — the one path every producer shares.
 *
 * A cron trigger's session, a webhook handler's session, and a human at a
 * terminal all reach the same route through this. There is no second way to
 * record a measurement, which is what stops "how do I declare a signal?" from
 * ever being a question (R-12a).
 */
async function goalsObserve(
  slug: string | undefined,
  opts: CtxOpts,
  flags: { metric?: string; value?: string; source?: string; at?: string },
  json = false,
): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a goal slug.')}\n`);
    return 2;
  }

  let body: ObserveBody;
  try {
    body = buildObserveBody(flags);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: AgiObserveResponse;
  try {
    resp = await ctx.client.post<AgiObserveResponse>(
      `/projects/${ctx.projectId}/agi/goals/${encodeURIComponent(slug)}/observations`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  const o = resp.observation;
  process.stdout.write(
    `${status.ok(`recorded ${o.goal_slug}  ${o.metric} = ${o.value}  (${o.source})`)}\n`,
  );
  return 0;
}

// ── Goal liveness (spec §4.2 / §8) ──────────────────────────────────────────

/**
 * The liveness verdict for every goal, from the one route that computes it.
 *
 * It is a SECOND call because the verdict is derived from the observation
 * series, not from the manifest, and `goals ls` reads the manifest. A failure
 * here degrades to a warning and the ordinary listing rather than failing the
 * read: losing the stall column is bad, but refusing to show the board because
 * the stall column could not be computed is worse.
 */
async function fetchLiveness(ctx: {
  client: { get: <T>(path: string) => Promise<T> };
  projectId: string;
}): Promise<AgiLivenessResponse | null> {
  try {
    return await ctx.client.get<AgiLivenessResponse>(`/projects/${ctx.projectId}/agi/liveness`);
  } catch (err) {
    process.stderr.write(
      `${status.warn(`liveness unavailable — ${(err as Error).message}. Goal stalls are NOT shown below.`)}\n`,
    );
    return null;
  }
}

export function livenessBySlug(
  liveness: AgiLivenessResponse | null,
): Map<string, AgiGoalLiveness> | undefined {
  if (!liveness) return undefined;
  return new Map(liveness.goals.map((view) => [view.slug, view.liveness]));
}

/** The liveness cell, shouted for the two states that mean "you cannot tell
 *  whether this is working". */
export function renderGoalLivenessCell(liveness: AgiGoalLiveness): string {
  const label = goalLivenessLabel(liveness);
  if (liveness.state === 'stalled') {
    return `${C.yellow}${label}${C.reset} (${liveness.flat_metrics.map((m) => `${m.metric} flat×${m.flat_observations}`).join(', ')})`;
  }
  if (liveness.state === 'unmeasurable') return `${C.yellow}${label}${C.reset}`;
  return label;
}

/**
 * The one line under the goal list that answers "is anything stuck?".
 *
 * It reports `stalled_total` — tasks AND goals — because those are the two ways
 * a loop dies and a reader who only sees one of them has been told a
 * comfortable half-truth.
 */
export function renderLivenessSummary(liveness: AgiLivenessResponse | null): string {
  if (!liveness) return '';
  if (liveness.stalled_total === 0 && liveness.unmeasurable_goal_count === 0) {
    return `  ${C.dim}nothing stalled${C.reset}\n`;
  }
  const lines: string[] = [];
  if (liveness.stalled_total > 0) {
    lines.push(
      status.warn(
        `stalled_total ${liveness.stalled_total} — ${liveness.stalled_count} task${liveness.stalled_count === 1 ? '' : 's'}, ${liveness.stalled_goal_count} goal${liveness.stalled_goal_count === 1 ? '' : 's'}. Run \`kortix tasks stalled\`.`,
      ),
    );
  }
  if (liveness.unmeasurable_goal_count > 0) {
    lines.push(
      status.warn(
        `${liveness.unmeasurable_goal_count} goal${liveness.unmeasurable_goal_count === 1 ? '' : 's'} unmeasurable — a threshold nobody has ever measured. Record one with \`kortix goals observe\`.`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The stall block under `goals show`'s metrics table. Null when the goal is
 *  measuring, settled, or paused — advice nobody needs is noise. */
export function renderGoalStallNotice(view: AgiGoalLivenessView | null): string {
  const guidance = view ? goalStallGuidance(view) : null;
  if (!view || !guidance) return '';
  // `unquantified` is legal under R-7 and gets the informational voice; the
  // other two are defects in the ability to judge the goal at all.
  const head =
    view.liveness.state === 'unquantified'
      ? status.info(`${goalLivenessLabel(view.liveness)} — ${guidance.what}`)
      : status.warn(`${goalLivenessLabel(view.liveness)} — ${guidance.what}`);
  const next = guidance.next.map((cmd) => `  ${C.dim}${pad('next', 10)}${C.reset}${cmd}`).join('\n');
  return `\n${head}\n${next}\n`;
}

// ── Exported helpers (pure — unit-tested directly) ──────────────────────────

export interface ObserveBody {
  metric: string;
  value: number;
  source?: string;
  observed_at?: string;
}

/**
 * Validate `observe`'s flags before a round trip.
 *
 * `--value` is parsed with `Number()` and then checked for finiteness, which is
 * the whole guard: `Number('')` is 0 and `Number('1e999')` is Infinity, so a
 * missing or nonsense value would otherwise be recorded as a reading that was
 * never taken. The metric name is left alone here on purpose — the server owns
 * normalization, so the CLI and a webhook posting directly cannot disagree about
 * which series a name belongs to.
 */
export function buildObserveBody(flags: {
  metric?: string;
  value?: string;
  source?: string;
  at?: string;
}): ObserveBody {
  const metric = flags.metric?.trim();
  if (!metric) throw new Error('--metric is required');

  if (flags.value === undefined || flags.value.trim() === '') {
    throw new Error('--value is required');
  }
  const value = Number(flags.value.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`--value must be a finite number (got "${flags.value}")`);
  }

  const body: ObserveBody = { metric, value };
  if (flags.source?.trim()) body.source = flags.source.trim();
  if (flags.at?.trim()) {
    const at = Date.parse(flags.at.trim());
    if (Number.isNaN(at)) throw new Error(`--at must be an ISO-8601 timestamp (got "${flags.at}")`);
    body.observed_at = new Date(at).toISOString();
  }
  return body;
}

/** Arrow for a metric's direction of travel. `?` for a metric with one reading:
 *  it is measured but has not yet proved anything about movement. */
export function directionMark(direction: AgiGoalMetric['direction']): string {
  switch (direction) {
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'flat':
      return '→';
    default:
      return '?';
  }
}

/** Trailing zeros dropped, long decimals capped: a metrics table is scanned, and
 *  `9.300000000000001` in a column is noise, not precision. */
export function formatMetricValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

/**
 * The series, compactly: the last few readings in order, ending at the present.
 *
 * Capped from the END so the newest readings are always the ones shown — a
 * truncated series that dropped the latest value would be worse than none.
 */
export const SERIES_PREVIEW = 6;

export function renderSeries(points: { value: number }[], cap = SERIES_PREVIEW): string {
  if (points.length === 0) return '-';
  const shown = points.slice(-cap);
  const body = shown.map((point) => formatMetricValue(point.value)).join(' → ');
  return points.length > shown.length ? `… → ${body}` : body;
}

/**
 * One row per metric: where it is, which way it is going, how long it has been
 * flat, and the series behind it. FLAT is a column rather than a footnote
 * because a flat run reaching the threshold is what R-12e turns into a stall.
 */
export function renderMetricTable(metrics: AgiGoalMetricSeries[]): string {
  const nameW = Math.max(...metrics.map((m) => m.metric.length), 6);
  const valueW = Math.max(...metrics.map((m) => formatMetricValue(m.latest.value).length), 5);
  const flatW = Math.max(...metrics.map((m) => String(m.flat_observations).length), 4);

  const rows = [
    `  ${C.dim}${pad('METRIC', nameW)}   ${pad('LATEST', valueW)}   ${pad('DIR', 3)}   ${pad('FLAT', flatW)}   SERIES${C.reset}`,
  ];
  for (const m of metrics) {
    rows.push(
      `  ${pad(m.metric, nameW)}   ${pad(formatMetricValue(m.latest.value), valueW)}   ${pad(directionMark(m.direction), 3)}   ${pad(String(m.flat_observations), flatW)}   ${renderSeries(m.series)}`,
    );
  }
  return `${rows.join('\n')}\n`;
}

/**
 * What to print for a goal with no metrics at all.
 *
 * R-12d's distinction, in one line each. `unmeasurable` is a WARNING because a
 * threshold nobody measures is a goal nobody can judge; `unquantified` is
 * informational because a purely qualitative `done_when` is legal (R-7) and
 * simply has nothing to plot.
 */
export function measurabilityNotice(goal: Pick<AgiGoal, 'measurability' | 'slug'>): string {
  if (goal.measurability === 'unmeasurable') {
    return status.warn(
      `UNMEASURABLE — done_when names a threshold and nothing has ever been recorded. Record one with: kortix goals observe ${goal.slug} --metric <name> --value <number>`,
    );
  }
  return status.info('No metrics recorded — done_when names no threshold to measure.');
}

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

/**
 * The METRIC cell for one goal in the list.
 *
 * A goal has few metrics (R-10 puts goals in single digits and each carries a
 * handful), but the list is one screen, so only the FLATTEST one is shown — that
 * is the metric closest to becoming a stall and therefore the one worth a
 * column. A goal with nothing recorded prints its measurability instead of a
 * blank, because a blank cell reads as "fine".
 */
export function goalMetricCell(goal: Pick<AgiGoal, 'metrics' | 'measurability'>): string {
  if (goal.metrics.length === 0) {
    return goal.measurability === 'unmeasurable' ? 'UNMEASURABLE' : '-';
  }
  const worst = [...goal.metrics].sort((a, b) => b.flat_observations - a.flat_observations)[0];
  const flat = worst.flat_observations > 0 ? ` flat×${worst.flat_observations}` : '';
  return `${worst.metric} ${formatMetricValue(worst.latest.value)} ${directionMark(worst.direction)}${flat}`;
}

/**
 * The goal list.
 *
 * `liveness` is optional and the LIVE column appears only when it is supplied:
 * a column of blanks would read as "everything is fine" when the truth is "we
 * could not find out", and those must never look the same.
 */
export function renderGoalTable(
  goals: AgiGoal[],
  liveness?: Map<string, AgiGoalLiveness>,
): string {
  const liveCell = (g: AgiGoal) => {
    const entry = liveness?.get(g.slug);
    return entry ? goalLivenessLabel(entry) : '-';
  };
  const slugW = Math.max(...goals.map((g) => g.slug.length), 4);
  const statusW = Math.max(...goals.map((g) => g.status.length), 6);
  const liveW = liveness ? Math.max(...goals.map((g) => liveCell(g).length), 4) : 0;
  const pushW = Math.max(...goals.map((g) => (g.push ?? '-').length), 4);
  const openW = Math.max(...goals.map((g) => String(g.open_task_count).length), 4);
  const metricW = Math.max(...goals.map((g) => goalMetricCell(g).length), 6);
  const liveHead = liveness ? `${pad('LIVE', liveW)}   ` : '';

  const rows = [
    `  ${C.dim}${pad('SLUG', slugW)}   ${pad('STATUS', statusW)}   ${liveHead}${pad('PUSH', pushW)}   ${pad('OPEN', openW)}   ${pad('METRIC', metricW)}   TITLE${C.reset}`,
  ];
  for (const g of goals) {
    const live = liveness ? `${pad(liveCell(g), liveW)}   ` : '';
    rows.push(
      `  ${pad(g.slug, slugW)}   ${pad(g.status, statusW)}   ${live}${pad(g.push ?? '-', pushW)}   ${pad(String(g.open_task_count), openW)}   ${pad(goalMetricCell(g), metricW)}   ${g.title}`,
    );
  }
  return `${rows.join('\n')}\n`;
}
