import { formatDurationSeconds } from '@kortix/manifest-schema';
import {
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  buildWebhookSampleRequest,
} from '@kortix/shared';
import type { ProjectTrigger, ProjectTriggersResponse, TriggerFireResponse } from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
  type CtxOpts,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import {
  triggersAddLive,
  triggersRmLive,
  triggersSetLive,
  triggersToggleLive,
} from './triggers-live.ts';
import { triggersAddLocal, triggersRmLocal, triggersToggle } from './triggers-manifest.ts';

const HELP = help`Usage: kortix triggers <subcommand> [options]

Manage the [[triggers]] declared in your project's kortix.yaml — cron
schedules, webhooks, and monitors. add/rm/enable/disable edit the LOCAL
manifest (the source of truth); \`kortix ship\` applies them. When kortix.yaml
lists \`imports:\`, rm/enable/disable edit the file that declares the trigger;
add writes to kortix.yaml. ls/fire/info
read live state from the cloud. pause/resume are a SERVER-SIDE activation
switch (cloud state, not the manifest).

Subcommands:
  ls [--json]              List triggers + runtime state.
  add <slug> [options]     Append a [[triggers]] block (cron, webhook, monitor).
             [--apply]     Create it on the cloud project now instead (commit
                           to kortix.yaml on main + reconcile).
  set <slug> [options]     Change a LIVE trigger. Only the flags you pass are
                           written. Always applies now — there is no local form.
  rm <slug> [--apply]      Remove a trigger from kortix.yaml (or from the cloud
                           project now).
  fire <slug>              Manually fire a trigger now.
  enable <slug> [--apply]  Set enabled = true on a trigger.
  disable <slug> [--apply] Set enabled = false on a trigger.
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
  --run-at <iso>           Run ONCE at this instant instead of on a cron.
  --timezone <tz>          Timezone for cron/run-at (default UTC).
  --secret-env <NAME>      HMAC secret env var (webhook type).
  --name <label>           Display name (default: slug).
  --disabled               Create it disabled (default enabled).

Live-only options (--apply on \`add\`, and every \`set\`):
  --model <provider/model> Model for the spawned session. Omit for the default.
  --session-mode <m>       fresh | keyed | pinned | reuse.
  --session-key <tmpl>     Bucket one session per key, e.g.
                           "{{ body.data.chat_jid }}". Implies keyed.
  --session-id <id>        The session a \`pinned\` trigger loops. Must be this
                           project's session.
  --session-access <mode>  Who may open the spawned session: private (default),
                           project, or members.
  --member <uuid>          Grant one member access. Repeat. Implies members.
  --group <uuid>           Grant one group access. Repeat. Implies members.
  --filter <path=value>    Only fire when the payload matches. Repeat for more;
                           every one must match. e.g. --filter body.type=push

Set options: every live-only option above, plus --name, --prompt, --cron,
--run-at, --timezone, --secret-env, --agent, and --enabled true|false.
\`--cron\` and \`--run-at\` are exclusive — setting one clears the other. Monitor
fields (--run/--mode/--interval/--expect-event-within) are add-only.

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
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  const tf: Record<string, string | undefined> = {};
  let disabled = false;
  let json = false;
  let applyRemote = false;
  let members: string[] = [];
  let groups: string[] = [];
  let filters: string[] = [];
  try {
    json = takeFlagBool(rest, ['--json']);
    applyRemote = takeFlagBool(rest, ['--apply']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    tf.runAt = takeFlagValue(rest, ['--run-at']);
    tf.model = takeFlagValue(rest, ['--model']);
    tf.sessionMode = takeFlagValue(rest, ['--session-mode']);
    tf.sessionKey = takeFlagValue(rest, ['--session-key']);
    tf.sessionId = takeFlagValue(rest, ['--session-id']);
    tf.sessionAccess = takeFlagValue(rest, ['--session-access']);
    tf.enabled = takeFlagValue(rest, ['--enabled']);
    members = takeFlagValues(rest, ['--member']);
    groups = takeFlagValues(rest, ['--group']);
    filters = takeFlagValues(rest, ['--filter']);
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
      if (i >= 0) {
        rest.splice(i, 1);
        return true;
      }
      return false;
    })();
  } catch (err) {
    return fail((err as Error).message);
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (sub) {
    case 'ls':
      return triggersLs(ctxOpts, json);
    case 'add':
    case 'create':
      return applyRemote
        ? triggersAddLive(positional[0], tf, disabled, { members, groups, filters }, ctxOpts, json)
        : triggersAddLocal(positional[0], tf, disabled);
    case 'set':
    case 'update':
      // No local form: a partial edit of a [[triggers]] block would have to
      // re-derive the whole entry, which is exactly what the API already does.
      return triggersSetLive(positional[0], tf, { members, groups, filters }, ctxOpts, json);
    case 'rm':
    case 'remove':
    case 'delete':
      return applyRemote
        ? triggersRmLive(positional[0], ctxOpts, json)
        : triggersRmLocal(positional[0]);
    case 'fire':
      return triggersFire(positional[0], ctxOpts);
    case 'enable':
      return applyRemote
        ? triggersToggleLive(positional[0], true, ctxOpts, json)
        : triggersToggle(positional[0], true);
    case 'disable':
      return applyRemote
        ? triggersToggleLive(positional[0], false, ctxOpts, json)
        : triggersToggle(positional[0], false);
    case 'pause':
      return triggersActivation(ctxOpts, true);
    case 'resume':
      return triggersActivation(ctxOpts, false);
    case 'info':
    case 'show':
      return triggersInfo(positional[0], ctxOpts, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function triggersLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.get<ProjectTriggersResponse>(`/projects/${ctx.projectId}/triggers`);
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
    process.stdout.write(
      `  ${C.dim}No triggers declared. Add [[triggers]] to kortix.yaml.${C.reset}\n`,
    );
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
      const failed = t.last_status === 'failed' ? `  ${C.red}last run failed${C.reset}` : '';
      process.stdout.write(
        `  ${pad(t.slug, slugW)}   ${pad(t.name, nameW)}   ${pad(t.type, 7)}  ${state}   ${pad(trimMid(detail, 30), 30)}  ${C.faded}${lastFired}${C.reset}${failed}\n`,
      );
    }
    process.stdout.write(
      `\n  ${C.dim}${resp.triggers.length} trigger${resp.triggers.length === 1 ? '' : 's'}${C.reset}\n`,
    );
  }

  if (resp.errors.length > 0) {
    process.stdout.write(
      `\n  ${status.warn(`${resp.errors.length} manifest error${resp.errors.length === 1 ? '' : 's'}:`)}\n`,
    );
    for (const e of resp.errors) {
      process.stdout.write(`    ${C.red}${e.path}${C.reset}: ${e.error}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

async function triggersFire(slug: string | undefined, opts: CtxOpts): Promise<number> {
  if (!slug) return missing('a trigger slug');
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
    process.stdout.write(
      `${status.ok(`Fired ${C.bold}${slug}${C.reset} → session ${C.dim}${resp.session_id}${C.reset}`)}\n`,
    );
  } else if (resp.status === 'queued') {
    process.stdout.write(
      `${status.info(`Queued ${C.bold}${slug}${C.reset}${resp.reason ? `${C.dim} — ${resp.reason}${C.reset}` : ''}`)}\n`,
    );
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

async function triggersInfo(
  slug: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.get<ProjectTriggersResponse>(`/projects/${ctx.projectId}/triggers`);
  } catch (err) {
    return surfaceApiError(err);
  }
  const t = resp.triggers.find((x) => x.slug === slug);
  if (!t) {
    process.stderr.write(`${status.err(`No trigger "${slug}".`)}\n`);
    return 1;
  }

  if (json) {
    emitJson(
      t.type === 'webhook' && t.webhook_url
        ? {
            ...t,
            webhook_signing: {
              header: WEBHOOK_SIGNATURE_HEADER,
              algorithm: WEBHOOK_SIGNATURE_ALGORITHM,
              sample_request: buildWebhookSampleRequest(t.webhook_url),
            },
          }
        : t,
    );
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
    if (t.run_at) rows.push(['run_at', String(t.run_at)]);
  } else if (t.type === 'monitor') {
    rows.push(['run', t.run ?? '—'], ['mode', t.mode ?? '—']);
    if (t.interval_seconds !== null && t.interval_seconds !== undefined) {
      rows.push(['interval', formatDurationSeconds(t.interval_seconds)]);
    }
    if (t.expect_event_within_seconds !== null && t.expect_event_within_seconds !== undefined) {
      rows.push(['expect_event_within', formatDurationSeconds(t.expect_event_within_seconds)]);
    }
  } else {
    rows.push(['secret_env', t.secret_env ?? '—']);
    if (t.webhook_url) rows.push(['webhook_url', t.webhook_url]);
    rows.push(['signature', `${WEBHOOK_SIGNATURE_HEADER}: ${WEBHOOK_SIGNATURE_ALGORITHM}`]);
  }
  rows.push(['last_fired', t.last_fired_at ?? 'never']);
  if (t.last_status)
    rows.push([
      'last_status',
      t.last_status === 'failed' ? `${C.red}failed${C.reset}` : t.last_status,
    ]);
  if (t.last_error) rows.push(['last_error', t.last_error]);
  rows.push(['prompt', trimMid(t.prompt_template.replace(/\n/g, ' '), 80)]);
  const labelW = Math.max(...rows.map(([label]) => label.length)) + 1;

  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${t.name}${C.reset} ${C.faded}(${t.slug})${C.reset}\n`);
  for (const [label, value] of rows) {
    process.stdout.write(`  ${C.dim}${pad(label, labelW)} ${C.reset}${value}\n`);
  }
  if (t.type === 'webhook' && t.webhook_url) {
    process.stdout.write(`\n  ${C.dim}Sample request${C.reset}\n\n`);
    for (const line of buildWebhookSampleRequest(t.webhook_url).split('\n')) {
      process.stdout.write(line ? `    ${line}\n` : '\n');
    }
  }
  process.stdout.write('\n');
  return 0;
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
