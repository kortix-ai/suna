import { formatDurationSeconds, parseDurationSeconds } from '@kortix/manifest-schema';
import {
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  buildWebhookSampleRequest,
} from '@kortix/shared';
import type { ApiClient } from '../api/client.ts';
import type {
  ProjectSession,
  ProjectTrigger,
  ProjectTriggersResponse,
  TriggerFireResponse,
} from '../api/types.ts';
import { splitHelp } from '../command-argv.ts';
import {
  type CtxOpts,
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import {
  triggersAddLive,
  triggersRmLive,
  triggersSetLive,
  triggersToggleLive,
} from './triggers-live.ts';
import { eventNextStep, triggersEvents } from './triggers-events.ts';
import {
  collectEventConfig,
  triggersAddLocal,
  triggersRmLocal,
  triggersToggle,
} from './triggers-manifest.ts';

const HELP = help`Usage: kortix triggers <subcommand> [options]

Manage the [[triggers]] declared in your project's kortix.yaml — cron
schedules, webhooks, monitors, and app events. add/rm/enable/disable edit the LOCAL
manifest (the source of truth); \`kortix ship\` applies them. When kortix.yaml
lists \`imports:\`, rm/enable/disable edit the file that declares the trigger;
add writes to kortix.yaml. ls/fire/info
read live state from the cloud. pause/resume are a SERVER-SIDE activation
switch (cloud state, not the manifest).

Subcommands:
  ls [--json]              List triggers + runtime state.
  add <slug> [options]     Append a [[triggers]] block (cron, webhook, monitor, event).
             [--apply]     Create it on the cloud project now instead (commit
                           to kortix.yaml on main + reconcile).
  set <slug> [options]     Change a LIVE trigger. Only the flags you pass are
                           written. Always applies now — there is no local form.
  rm <slug> [--apply]      Remove a trigger from kortix.yaml (or from the cloud
                           project now).
  fire <slug>              Manually fire a trigger now, wait for the run
                           outcome, and exit non-zero with the failure text
                           when the run fails. The fired run's fresh session is
                           cleaned up on failure (a run queued into an existing
                           session leaves it), so its API key does not outlive
                           the run.
                           [--wait <dur>]  How long to watch for the outcome
                           (default 90s; 0 returns as soon as the fire is
                           accepted).
  enable <slug> [--apply]  Set enabled = true on a trigger.
  disable <slug> [--apply] Set enabled = false on a trigger.
  pause                    Deactivate ALL of this project's triggers server-side
                           (crons + webhooks stop auto-running). Use it on one
                           of two deployments of the same repo to stop double-
                           firing. Manual \`fire\` still works.
  resume                   Re-activate this project's triggers server-side.
  info <slug> [--json]     Show one trigger in full.
  events --apps [--json]   List apps that can trigger events, with their
                           connector and whether a shared account is connected.
  events --connector <slug> [--json]
                           List the events a connector can trigger on.
  events --connector <slug> --event <TYPE> [--json]
                           One event in full: config fields (type, required,
                           default, allowed values, description) and the
                           {{ event.data.* }} prompt variables.

Add options:
  --type <cron|webhook|monitor|event>
                           Trigger type (default cron).
  --prompt <text>          Initial prompt for the spawned session (required).
  --agent <name>           Logical agent to run (default: project default_agent).
  --cron <expr>            6-field cron (cron type), seconds first, at most
                           once a minute. e.g. "0 0 9 * * 1-5".
  --run-at <iso>           Run ONCE at this instant instead of on a cron.
  --timezone <tz>          Timezone for cron/run-at (default UTC).
  --secret-env <NAME>      HMAC secret env var (webhook type).
  --name <label>           Display name (default: slug).
  --disabled               Create it disabled (default enabled).

Event options (--type event). Run the agent when an app event happens on a
connected app (e.g. a new pull request). The prompt reads the event as
{{ event.data.<field> }}, plus event.id, event.type, event.app,
event.connector, and event.occurred_at.
  --connector <slug>       The project's connector the event happens on
                           (required).
  --event <TYPE>           Provider event type, e.g. GITHUB_PULL_REQUEST_CREATED
                           (required; list with \`triggers events\`).
  --config <key=value>     Event config field. Repeat for more. Values are
                           converted to the field's type (number, boolean,
                           comma list) using the event catalog.
  --config-json <json>     Event config as a JSON object, for typed values.
                           --config keys override it. On \`set\` it REPLACES the
                           config; bare --config MERGES into the current one.
Online, \`add\` and \`set\` check the config against the catalog and list every
missing or invalid field with its description. \`add --apply\` then prints the
trigger status and the next step. Autonomous setup:
  1. kortix triggers events --apps
  2. kortix connectors add <slug> --provider composio --app <app> --apply
  3. kortix connectors connect <slug> --owner project   (a person opens the link)
  4. kortix triggers events --connector <slug> --event <TYPE>
  5. kortix triggers add <slug> --type event --connector <slug> --event <TYPE> \\
       --config <k>=<v> --prompt "…{{ event.data.<field> }}…" --apply
  6. kortix triggers info <slug>   (until it prints "live")
Event triggers take none of --cron, --run-at, --timezone, --secret-env,
--run, --mode, --interval, or --expect-event-within.

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
  let configPairs: string[] = [];
  let configJson: string | undefined;
  let apps = false;
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
    configPairs = takeFlagValues(rest, ['--config']);
    configJson = takeFlagValue(rest, ['--config-json']);
    apps = takeFlagBool(rest, ['--apps']);
    tf.connector = takeFlagValue(rest, ['--connector']);
    tf.event = takeFlagValue(rest, ['--event']);
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
    tf.wait = takeFlagValue(rest, ['--wait']);
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
  const eventConfig = collectEventConfig(configPairs, configJson);
  if (typeof eventConfig === 'object') return fail(eventConfig.error);
  tf.eventConfig = eventConfig;
  if (configJson !== undefined) tf.eventConfigReplace = '1';
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (sub) {
    case 'ls':
      return triggersLs(ctxOpts, json);
    case 'add':
    case 'create':
      return applyRemote
        ? triggersAddLive(positional[0], tf, disabled, { members, groups, filters }, ctxOpts, json)
        : triggersAddLocal(positional[0], tf, disabled, ctxOpts);
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
      return triggersFire(positional[0], tf.wait, ctxOpts);
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
    case 'events':
      return triggersEvents({ apps, connector: tf.connector, event: tf.event }, ctxOpts, json);
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
      const eventNote =
        t.type === 'event' && t.event
          ? `  ${t.event.status === 'active' ? C.green : t.event.status === 'error' ? C.red : C.yellow}${eventNextStep(t).word}${C.reset}`
          : '';
      const lastFired = t.last_fired_at ? formatRelative(t.last_fired_at) : '—';
      const failed = t.last_status === 'failed' ? `  ${C.red}last run failed${C.reset}` : '';
      process.stdout.write(
        `  ${pad(t.slug, slugW)}   ${pad(t.name, nameW)}   ${pad(t.type, 7)}  ${state}   ${pad(trimMid(detail, 30), 30)}  ${C.faded}${lastFired}${C.reset}${failed}${eventNote}\n`,
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

/** How long `triggers fire` watches for the run outcome when --wait is not given. */
const FIRE_DEFAULT_WAIT_SECONDS = 90;
const FIRE_POLL_INTERVAL_MS = 1_000;

async function triggersFire(
  slug: string | undefined,
  waitFlag: string | undefined,
  opts: CtxOpts,
): Promise<number> {
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

  const fired = resp.status === 'fired';
  // The printed session id must be one the caller can open. The API hands one
  // back only after the session row exists, so a read that fails here is worth
  // failing on, not printing green over.
  if (resp.session_id) {
    try {
      await ctx.client.get<ProjectSession>(
        `/projects/${ctx.projectId}/sessions/${resp.session_id}`,
      );
    } catch (err) {
      process.stderr.write(
        `${status.err(
          `The fired session ${C.bold}${resp.session_id}${C.reset} could not be read (${(err as Error).message}). Its run outcome is on the trigger: \`kortix triggers ls\`.`,
        )}\n`,
      );
      return 1;
    }
  }

  const waitSeconds =
    waitFlag === undefined
      ? FIRE_DEFAULT_WAIT_SECONDS
      : waitFlag === '0'
        ? 0
        : parseDurationSeconds(waitFlag);
  if (waitSeconds === null) {
    return fail(`--wait must be a duration like 30s or 5m (got "${waitFlag}")`);
  }

  const watch = waitSeconds > 0 ? await triggerRunOutcome(ctx, slug, waitSeconds) : null;
  if (watch?.outcome === 'failed') {
    process.stderr.write(
      `${status.err(`Trigger ${C.bold}${slug}${C.reset} run failed: ${watch.error}`)}\n`,
    );
    if (fired && resp.session_id) {
      // The dead session's per-session API key only dies with the session
      // (deleteSession revokes it), so the failed run's fresh session is
      // cleaned up here instead of leaking a live bearer. A run queued into an
      // existing session (queued response) leaves that session alone.
      try {
        await ctx.client.delete(`/projects/${ctx.projectId}/sessions/${resp.session_id}`);
        process.stdout.write(
          `${C.dim}Cleaned up the failed run's session ${resp.session_id}.${C.reset}\n`,
        );
      } catch {
        process.stdout.write(
          `${C.dim}The failed run's session ${resp.session_id} could not be deleted — remove it with \`kortix sessions rm ${resp.session_id}\`.${C.reset}\n`,
        );
      }
    }
    return 1;
  }

  // What the wait observed — never more than that. A window that expired with
  // the watch running is "no failure observed", never "succeeded"; a watch
  // that never started (runtime state unreadable, no attempt stamp) says so
  // instead of claiming a no-failure window it did not watch.
  let note = '';
  if (watch?.outcome === 'watched') {
    note = ` ${C.dim}— no failure within ${formatDurationSeconds(waitSeconds)}; the run is still going or finished clean. \`kortix triggers ls\` shows the outcome.${C.reset}`;
  } else if (watch?.outcome === 'unwatched') {
    note = ` ${C.dim}— could not watch the run outcome (${watch.reason}); \`kortix triggers ls\` shows it.${C.reset}`;
  }
  if (fired && resp.session_id) {
    process.stdout.write(
      `${status.ok(`Fired ${C.bold}${slug}${C.reset} → session ${C.dim}${resp.session_id}${C.reset}`)}${note}\n`,
    );
  } else if (!fired) {
    process.stdout.write(
      `${status.info(`Queued ${C.bold}${slug}${C.reset}${resp.reason ? `${C.dim} — ${resp.reason}${C.reset}` : ''}`)}${note}\n`,
    );
  } else {
    process.stdout.write(`${status.ok(`Fired ${C.bold}${slug}${C.reset}`)}\n`);
  }
  return 0;
}

/**
 * Watch the trigger's runtime row for the run's outcome. The fire's own write
 * stamps `last_attempt_at`; any later write is a run end, so a `failed` row
 * with a later attempt is THIS run's failure — never the stale one a fire over
 * a failing trigger keeps (keepRunFailure keeps the old failure under the
 * fire's own attempt stamp). A healthy run writes nothing, so a window that
 * expires with the watch running is `watched` — "no failure observed", never
 * "succeeded". A watch that never started is `unwatched`, so the caller cannot
 * print a no-failure claim it did not earn.
 */
async function triggerRunOutcome(
  ctx: { client: ApiClient; projectId: string },
  slug: string,
  waitSeconds: number,
): Promise<
  | { outcome: 'failed'; error: string }
  | { outcome: 'watched' }
  | { outcome: 'unwatched'; reason: string }
> {
  const readTrigger = async (): Promise<ProjectTrigger | undefined> => {
    const resp = await ctx.client.get<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers`,
    );
    return resp.triggers.find((t) => t.slug === slug);
  };
  // The anchor is the fire's own attempt stamp: without it no later write can
  // be told apart from the fire, so a transient read failure gets retried
  // before the watch starts rather than silently disabling it.
  let anchor: ProjectTrigger | undefined;
  for (let attempt = 0; attempt < 3 && !anchor?.last_attempt_at; attempt += 1) {
    try {
      anchor = await readTrigger();
    } catch {
      if (attempt < 2) await Bun.sleep(500);
    }
  }
  if (!anchor?.last_attempt_at) {
    return {
      outcome: 'unwatched',
      reason: anchor ? 'the trigger row has no attempt stamp' : 'the trigger row was not readable',
    };
  }
  if (anchor.last_status === 'failed' && anchor.last_error) {
    // A fire over a failing trigger keeps the old failure until a run finishes.
    process.stdout.write(`${C.dim}Previous run failed: ${anchor.last_error}${C.reset}\n`);
  }
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(Math.min(FIRE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    let row: ProjectTrigger | undefined;
    try {
      row = await readTrigger();
    } catch {
      continue; // a transient read error is not a run outcome
    }
    if (
      row?.last_status === 'failed' &&
      row.last_error &&
      row.last_attempt_at &&
      row.last_attempt_at > anchor.last_attempt_at
    ) {
      return { outcome: 'failed', error: row.last_error };
    }
  }
  return { outcome: 'watched' };
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
  } else if (t.type === 'event') {
    const e = t.event;
    rows.push(['connector', e ? `${e.connector}${e.app ? ` (${e.app})` : ''}` : '—']);
    rows.push(['event', e?.type ?? '—']);
    if (e && Object.keys(e.config).length > 0) rows.push(['config', JSON.stringify(e.config)]);
    rows.push([
      'event_status',
      e ? `${e.status === 'active' ? C.green : e.status === 'error' ? C.red : C.yellow}${eventNextStep(t).word}${C.reset}` : '—',
    ]);
    if (e?.error) rows.push(['event_error', e.error]);
    rows.push(['last_event', e?.last_event_at ?? 'never']);
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
  if (t.type === 'event') {
    const next = eventNextStep(t).lines;
    if (next.length > 0) process.stdout.write(`\n  ${C.dim}Next${C.reset}\n${next.map((l) => `    ${l}\n`).join('')}`);
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

/** One-line schedule/source column for `ls` — cron expression, webhook secret, monitor shape, or event source. */
function triggerDetail(t: ProjectTrigger): string {
  if (t.type === 'cron') return `${t.cron ?? '?'} (${t.timezone})`;
  if (t.type === 'monitor') {
    const mode = t.mode ?? '?';
    return t.interval_seconds !== null && t.interval_seconds !== undefined
      ? `${mode} ${formatDurationSeconds(t.interval_seconds)}`
      : mode;
  }
  if (t.type === 'event') {
    return t.event?.type ?? '?';
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
