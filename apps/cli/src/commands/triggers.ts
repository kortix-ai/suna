import {
  MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
  MONITOR_MIN_INTERVAL_SECONDS,
  MONITOR_MODES,
  MONITOR_RUN_MAX_LENGTH,
  formatDurationSeconds,
  parseDurationSeconds,
} from '@kortix/manifest-schema';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  appendArrayBlock,
  arrayEntryExists,
  removeArrayBlock,
  setScalarInArrayBlock,
} from '../manifest-edit.ts';
import { C, help, pad, status } from '../style.ts';
import type {
  ProjectTrigger,
  ProjectTriggersResponse,
  TriggerFireResponse,
} from '../api/types.ts';

const HELP = help`Usage: kortix triggers <subcommand> [options]

Manage the [[triggers]] declared in your project's kortix.yaml — cron
schedules, webhooks, and monitors. add/rm/enable/disable edit the LOCAL
kortix.yaml (the source of truth); \`kortix ship\` applies them. ls/fire/info
read live state from the cloud. pause/resume are a SERVER-SIDE activation
switch (cloud state, not the manifest).

Subcommands:
  ls [--json]              List triggers + runtime state.
  add <slug> [options]     Append a [[triggers]] block (cron, webhook, monitor).
  rm <slug>                Remove a trigger from kortix.yaml.
  fire <slug>              Manually fire a trigger now.
  enable <slug>            Set enabled = true on a trigger.
  disable <slug>           Set enabled = false on a trigger.
  pause                    Deactivate ALL of this project's triggers server-side
                           (crons + webhooks stop auto-running). Use it on one
                           of two deployments of the same repo to stop double-
                           firing. Manual \`fire\` still works.
  resume                   Re-activate this project's triggers server-side.
  info <slug> [--json]     Show one trigger in full.

Add options:
  --type <cron|webhook|monitor>
                           Trigger type (default cron).
  --prompt <text>          Initial prompt for the spawned session (required).
  --agent <name>           Logical agent to run (default: project default_agent).
  --cron <expr>            6-field cron (cron type). e.g. "0 0 9 * * 1-5".
  --timezone <tz>          Timezone for cron (default UTC).
  --secret-env <NAME>      HMAC secret env var (webhook type).
  --name <label>           Display name (default: slug).
  --disabled               Create it disabled (default enabled).

Monitor options (--type monitor). A monitor is a repo command the platform
runs 24/7; each stdout line fires the trigger. EXPERIMENTAL — the platform
runs monitors only where the \`monitors\` feature flag is on.
  --run <cmd>              Repo-relative command to supervise (required).
  --mode <poll|stream>     poll = re-run on --interval; stream = keep alive
                           (required).
  --interval <dur>         Poll period, mode=poll only. Min 30s. e.g. 60s, 5m.
  --expect-event-within <dur>
                           Silence watchdog: no event inside this window fires
                           a lifecycle event instead. Min 5m. e.g. 24h.

Global options:
  --project <id>     Operate on this project id (default: linked).
  -h, --help         Show this help.
`;

export async function runTriggers(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  const tf: Record<string, string | undefined> = {};
  let disabled = false;
  let json = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    tf.type = takeFlagValue(rest, ['--type']);
    tf.prompt = takeFlagValue(rest, ['--prompt']);
    tf.agent = takeFlagValue(rest, ['--agent']);
    tf.cron = takeFlagValue(rest, ['--cron']);
    tf.timezone = takeFlagValue(rest, ['--timezone']);
    tf.secretEnv = takeFlagValue(rest, ['--secret-env']);
    tf.run = takeFlagValue(rest, ['--run']);
    tf.mode = takeFlagValue(rest, ['--mode']);
    tf.interval = takeFlagValue(rest, ['--interval']);
    tf.expectEventWithin = takeFlagValue(rest, ['--expect-event-within']);
    tf.name = takeFlagValue(rest, ['--name']);
    disabled = (() => {
      const i = rest.indexOf('--disabled');
      if (i >= 0) { rest.splice(i, 1); return true; }
      return false;
    })();
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (sub) {
    case 'ls':
      return triggersLs(ctxOpts, json);
    case 'add':
    case 'create':
      return triggersAddLocal(positional[0], tf, disabled);
    case 'rm':
    case 'remove':
    case 'delete':
      return triggersRmLocal(positional[0]);
    case 'fire':
      return triggersFire(rest[0], ctxOpts);
    case 'enable':
      return triggersToggle(rest[0], true);
    case 'disable':
      return triggersToggle(rest[0], false);
    case 'pause':
      return triggersActivation(ctxOpts, true);
    case 'resume':
      return triggersActivation(ctxOpts, false);
    case 'info':
    case 'show':
      return triggersInfo(rest[0], ctxOpts, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

async function triggersLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.get<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  if (resp.triggers_paused) {
    process.stdout.write(
      `\n  ${status.warn('Triggers are PAUSED server-side for this project')} ${C.dim}— crons + webhooks won't auto-run (manual \`fire\` still works). \`kortix triggers resume\` to re-activate.${C.reset}\n`,
    );
  }

  if (resp.triggers.length === 0) {
    process.stdout.write(`  ${C.dim}No triggers declared. Add [[triggers]] to kortix.yaml.${C.reset}\n`);
  } else {
    const slugW = Math.max(...resp.triggers.map((t) => t.slug.length), 4);
    const nameW = Math.max(...resp.triggers.map((t) => t.name.length), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('SLUG', slugW)}   ${pad('NAME', nameW)}   TYPE     STATE     SCHEDULE / SECRET / MODE      LAST FIRED${C.reset}\n`,
    );
    for (const t of resp.triggers) {
      const state = t.enabled ? `${C.green}enabled ${C.reset}` : `${C.faded}disabled${C.reset}`;
      const detail = triggerDetail(t);
      const lastFired = t.last_fired_at ? formatRelative(t.last_fired_at) : '—';
      process.stdout.write(
        `  ${pad(t.slug, slugW)}   ${pad(t.name, nameW)}   ${pad(t.type, 7)}  ${state}   ${pad(trimMid(detail, 30), 30)}  ${C.faded}${lastFired}${C.reset}\n`,
      );
    }
    process.stdout.write(`\n  ${C.dim}${resp.triggers.length} trigger${resp.triggers.length === 1 ? '' : 's'}${C.reset}\n`);
  }

  if (resp.errors.length > 0) {
    process.stdout.write(`\n  ${status.warn(`${resp.errors.length} manifest error${resp.errors.length === 1 ? '' : 's'}:`)}\n`);
    for (const e of resp.errors) {
      process.stdout.write(`    ${C.red}${e.path}${C.reset}: ${e.error}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

async function triggersFire(slug: string | undefined, opts: CtxOpts): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: TriggerFireResponse;
  try {
    resp = await ctx.client.post<TriggerFireResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}/fire`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (resp.status === 'fired' && resp.session_id) {
    process.stdout.write(`${status.ok(`Fired ${C.bold}${slug}${C.reset} → session ${C.dim}${resp.session_id}${C.reset}`)}\n`);
  } else if (resp.status === 'queued') {
    process.stdout.write(`${status.info(`Queued ${C.bold}${slug}${C.reset}${resp.reason ? `${C.dim} — ${resp.reason}${C.reset}` : ''}`)}\n`);
  } else {
    process.stdout.write(`${status.ok(`Fired ${C.bold}${slug}${C.reset}`)}\n`);
  }
  return 0;
}

// Server-side activation switch (cloud state in projects.metadata, NOT the
// manifest). Pause = the platform stops auto-running this project's triggers.
async function triggersActivation(opts: CtxOpts, paused: boolean): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  try {
    await ctx.client.patch<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers/activation`,
      { paused },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    paused
      ? `${status.ok('Triggers PAUSED server-side')} ${C.dim}— this project's crons + webhooks won't auto-run. Manual \`fire\` still works.${C.reset}\n`
      : `${status.ok('Triggers RESUMED server-side')} ${C.dim}— this project's triggers will auto-run again.${C.reset}\n`,
  );
  return 0;
}

// add/rm a [[triggers]] block in the LOCAL kortix.yaml (source of truth).
function triggersAddLocal(
  slug: string | undefined,
  tf: Record<string, string | undefined>,
  disabled: boolean,
): number {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  const type = (tf.type ?? 'cron').toLowerCase();
  if (type !== 'cron' && type !== 'webhook' && type !== 'monitor') {
    process.stderr.write(`${status.err('--type must be cron, webhook, or monitor.')}\n`);
    return 2;
  }
  if (!tf.prompt) {
    process.stderr.write(`${status.err('--prompt is required.')}\n`);
    return 2;
  }
  if (type === 'cron' && !tf.cron) {
    process.stderr.write(`${status.err('cron triggers need --cron "<6-field expr>".')}\n`);
    return 2;
  }
  // Monitor flags on a cron/webhook trigger are a hard error, not a silent
  // drop — the platform would never read them.
  if (type !== 'monitor') {
    const stray = MONITOR_ONLY_FLAGS.find(([, value]) => tf[value] !== undefined);
    if (stray) {
      process.stderr.write(
        `${status.err(`${stray[0]} is only valid on a monitor trigger (--type monitor).`)}\n`,
      );
      return 2;
    }
  }
  let monitor: MonitorFields | null = null;
  if (type === 'monitor') {
    const parsed = parseMonitorFlags(tf);
    if ('error' in parsed) {
      process.stderr.write(`${status.err(parsed.error)}\n`);
      return 2;
    }
    monitor = parsed;
  }
  try {
    if (arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`A [[triggers]] "${slug}" already exists in kortix.yaml.`)}\n`);
      return 1;
    }
    const fields: Record<string, unknown> = { slug };
    if (tf.name) fields.name = tf.name;
    fields.type = type;
    if (tf.agent) fields.agent = tf.agent;
    fields.enabled = !disabled;
    if (type === 'cron') {
      fields.cron = tf.cron;
      fields.timezone = tf.timezone ?? 'UTC';
    } else if (type === 'monitor' && monitor) {
      fields.run = monitor.run;
      fields.mode = monitor.mode;
      // Durations are re-emitted canonically ("60s" → "1m"), the same
      // normalization the API's write path applies.
      if (monitor.intervalSeconds !== null) {
        fields.interval = formatDurationSeconds(monitor.intervalSeconds);
      }
      if (monitor.expectEventWithinSeconds !== null) {
        fields.expect_event_within = formatDurationSeconds(monitor.expectEventWithinSeconds);
      }
    } else if (tf.secretEnv) {
      fields.secret_env = tf.secretEnv;
    }
    fields.prompt = tf.prompt;
    appendArrayBlock('triggers', fields);
    process.stdout.write(
      `${status.ok(`Added [[triggers]] ${C.bold}${slug}${C.reset} (${type}) to kortix.yaml`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

function triggersRmLocal(slug: string | undefined): number {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  try {
    if (!removeArrayBlock('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.yaml.`)}\n`);
      return 1;
    }
    process.stdout.write(
      `${status.ok(`Removed [[triggers]] ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
}

// enabled is config — toggle it in the LOCAL kortix.yaml `[[triggers]]` block
// (the source of truth), preserving the block's comments. `kortix ship` applies.
function triggersToggle(slug: string | undefined, enabled: boolean): number {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  try {
    if (!arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.yaml.`)}\n`);
      return 1;
    }
    setScalarInArrayBlock('triggers', 'slug', slug, 'enabled', enabled);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  process.stdout.write(
    `${status.ok(`${enabled ? 'Enabled' : 'Disabled'} ${C.bold}${slug}${C.reset}`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
  );
  return 0;
}

async function triggersInfo(slug: string | undefined, opts: CtxOpts, json = false): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.get<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  const t = resp.triggers.find((x) => x.slug === slug);
  if (!t) {
    process.stderr.write(`${status.err(`No trigger "${slug}".`)}\n`);
    return 1;
  }

  if (json) {
    emitJson(t);
    return 0;
  }

  // One label column, sized to the widest label actually shown, so a monitor's
  // long `expect_event_within` doesn't leave the panel ragged.
  const rows: Array<[string, string]> = [
    ['type', t.type],
    ['enabled', t.enabled ? `${C.green}true${C.reset}` : `${C.faded}false${C.reset}`],
    ['agent', t.agent],
  ];
  if (t.type === 'cron') {
    rows.push(['cron', t.cron ?? '—'], ['timezone', t.timezone]);
  } else if (t.type === 'monitor') {
    rows.push(['run', t.run ?? '—'], ['mode', t.mode ?? '—']);
    if (t.interval_seconds !== null && t.interval_seconds !== undefined) {
      rows.push(['interval', formatDurationSeconds(t.interval_seconds)]);
    }
    if (t.expect_event_within_seconds !== null && t.expect_event_within_seconds !== undefined) {
      rows.push([
        'expect_event_within',
        formatDurationSeconds(t.expect_event_within_seconds),
      ]);
    }
  } else {
    rows.push(['secret_env', t.secret_env ?? '—']);
    if (t.webhook_url) rows.push(['webhook_url', t.webhook_url]);
  }
  rows.push(['last_fired', t.last_fired_at ?? 'never']);
  rows.push(['prompt', trimMid(t.prompt_template.replace(/\n/g, ' '), 80)]);
  const labelW = Math.max(...rows.map(([label]) => label.length)) + 1;

  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${t.name}${C.reset} ${C.faded}(${t.slug})${C.reset}\n`);
  for (const [label, value] of rows) {
    process.stdout.write(`  ${C.dim}${pad(label, labelW)} ${C.reset}${value}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── monitor flags ──────────────────────────────────────────────────────────

/** Flags that only mean something on a `--type monitor` add. */
const MONITOR_ONLY_FLAGS: ReadonlyArray<[string, string]> = [
  ['--run', 'run'],
  ['--mode', 'mode'],
  ['--interval', 'interval'],
  ['--expect-event-within', 'expectEventWithin'],
];

/** Flags that are cron/webhook wiring and are rejected on a monitor. */
const MONITOR_REJECTED_FLAGS: ReadonlyArray<[string, string]> = [
  ['--cron', 'cron'],
  ['--timezone', 'timezone'],
  ['--secret-env', 'secretEnv'],
];

interface MonitorFields {
  run: string;
  mode: string;
  intervalSeconds: number | null;
  expectEventWithinSeconds: number | null;
}

/**
 * Validate the `--type monitor` flags locally, rule for rule with the API's
 * `parseMonitorFields` and `@kortix/manifest-schema`'s `validateMonitorTrigger`.
 * The CLI writes the manifest, so it must reject exactly what `kortix ship`
 * would reject — a manifest that only fails server-side is a worse error than
 * no manifest at all. Spec: docs/specs/2026-08-12-monitors.md.
 */
function parseMonitorFlags(
  tf: Record<string, string | undefined>,
): MonitorFields | { error: string } {
  const rejected = MONITOR_REJECTED_FLAGS.find(([, key]) => tf[key] !== undefined);
  if (rejected) {
    return {
      error: `${rejected[0]} is not valid on a monitor trigger — monitors are driven by their \`run\` process.`,
    };
  }

  const run = (tf.run ?? '').trim();
  if (!run) {
    return { error: 'monitor triggers need --run "<command>" (repo-relative).' };
  }
  if (run.length > MONITOR_RUN_MAX_LENGTH) {
    return { error: `--run must be at most ${MONITOR_RUN_MAX_LENGTH} characters.` };
  }
  if (/[\r\n]/.test(run)) {
    return { error: '--run must be a single command line — no newlines.' };
  }

  const mode = (tf.mode ?? '').trim().toLowerCase();
  if (!(MONITOR_MODES as readonly string[]).includes(mode)) {
    return {
      error: `--mode must be ${MONITOR_MODES.join(' or ')} (got "${mode || 'unset'}").`,
    };
  }

  let intervalSeconds: number | null = null;
  if (mode === 'poll') {
    const parsed = parseFlagDuration(tf.interval, '--interval', MONITOR_MIN_INTERVAL_SECONDS);
    if ('error' in parsed) return parsed;
    intervalSeconds = parsed.seconds;
  } else if (tf.interval !== undefined) {
    return {
      error: '--interval is only valid on a `--mode poll` monitor — a stream runs continuously.',
    };
  }

  let expectEventWithinSeconds: number | null = null;
  if (tf.expectEventWithin !== undefined) {
    const parsed = parseFlagDuration(
      tf.expectEventWithin,
      '--expect-event-within',
      MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
    );
    if ('error' in parsed) return parsed;
    expectEventWithinSeconds = parsed.seconds;
  }

  return { run, mode, intervalSeconds, expectEventWithinSeconds };
}

/** Parse a duration flag ("30s", "5m", "24h", "7d") against its platform floor. */
function parseFlagDuration(
  raw: string | undefined,
  flag: string,
  floorSeconds: number,
): { seconds: number } | { error: string } {
  const floor = formatDurationSeconds(floorSeconds);
  const value = (raw ?? '').trim();
  if (!value) {
    return {
      error: `${flag} is required here — a duration like "${floor}", "5m", or "24h" (minimum ${floor}).`,
    };
  }
  const seconds = parseDurationSeconds(value);
  if (seconds === null) {
    return {
      error: `${flag} must be a positive integer plus s/m/h/d, e.g. "${floor}" (got "${value}").`,
    };
  }
  if (seconds < floorSeconds) {
    return { error: `${flag} must be at least ${floor} (got "${value}").` };
  }
  return { seconds };
}

/** One-line schedule/source column for `ls` — cron expression, webhook secret, or monitor shape. */
function triggerDetail(t: ProjectTrigger): string {
  if (t.type === 'cron') return `${t.cron ?? '?'} (${t.timezone})`;
  if (t.type === 'monitor') {
    const mode = t.mode ?? '?';
    return t.interval_seconds !== null && t.interval_seconds !== undefined
      ? `${mode} ${formatDurationSeconds(t.interval_seconds)}`
      : mode;
  }
  return `secret_env=${t.secret_env ?? '?'}`;
}

// ── helpers ────────────────────────────────────────────────────────────────

function trimMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
