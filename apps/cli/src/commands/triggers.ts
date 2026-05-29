import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  appendArrayBlock,
  arrayEntryExists,
  removeArrayBlock,
  setScalarInArrayBlock,
} from '../manifest-edit.ts';
import { C, pad, status } from '../style.ts';
import type {
  ProjectTrigger,
  ProjectTriggersResponse,
  TriggerFireResponse,
} from '../api/types.ts';

const HELP = `Usage: kortix triggers <subcommand> [options]

Manage the [[triggers]] declared in your project's kortix.toml — cron
schedules and webhooks. add/rm/enable/disable edit the LOCAL kortix.toml
(the source of truth); \`kortix ship\` applies them. ls/fire/info read live
state from the cloud.

Subcommands:
  ls                       List triggers + runtime state.
  add <slug> [options]     Append a [[triggers]] block (cron or webhook).
  rm <slug>                Remove a trigger from kortix.toml.
  fire <slug>              Manually fire a trigger now.
  enable <slug>            Set enabled = true on a trigger.
  disable <slug>           Set enabled = false on a trigger.
  info <slug>              Show one trigger in full.

Add options:
  --type <cron|webhook>    Trigger type (default cron).
  --prompt <text>          Initial prompt for the spawned session (required).
  --agent <name>           Agent to run (default: the opencode default).
  --cron <expr>            6-field cron (cron type). e.g. "0 0 9 * * 1-5".
  --timezone <tz>          Timezone for cron (default UTC).
  --secret-env <NAME>      HMAC secret env var (webhook type).
  --name <label>           Display name (default: slug).
  --disabled               Create it disabled (default enabled).

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
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    tf.type = takeFlagValue(rest, ['--type']);
    tf.prompt = takeFlagValue(rest, ['--prompt']);
    tf.agent = takeFlagValue(rest, ['--agent']);
    tf.cron = takeFlagValue(rest, ['--cron']);
    tf.timezone = takeFlagValue(rest, ['--timezone']);
    tf.secretEnv = takeFlagValue(rest, ['--secret-env']);
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
      return triggersLs(ctxOpts);
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
    case 'info':
    case 'show':
      return triggersInfo(rest[0], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

async function triggersLs(opts: CtxOpts): Promise<number> {
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ProjectTriggersResponse;
  try {
    resp = await ctx.client.get<ProjectTriggersResponse>(
      `/projects/${ctx.projectId}/triggers`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (resp.triggers.length === 0) {
    process.stdout.write(`  ${C.dim}No triggers declared. Add [[triggers]] to kortix.toml.${C.reset}\n`);
  } else {
    const slugW = Math.max(...resp.triggers.map((t) => t.slug.length), 4);
    const nameW = Math.max(...resp.triggers.map((t) => t.name.length), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('SLUG', slugW)}   ${pad('NAME', nameW)}   TYPE     STATE     SCHEDULE / SECRET             LAST FIRED${C.reset}\n`,
    );
    for (const t of resp.triggers) {
      const state = t.enabled ? `${C.green}enabled ${C.reset}` : `${C.faded}disabled${C.reset}`;
      const detail =
        t.type === 'cron'
          ? `${t.cron ?? '?'} (${t.timezone})`
          : `secret_env=${t.secret_env ?? '?'}`;
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
  const ctx = resolveProjectContext(opts);
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

// add/rm a [[triggers]] block in the LOCAL kortix.toml (source of truth).
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
  if (type !== 'cron' && type !== 'webhook') {
    process.stderr.write(`${status.err('--type must be cron or webhook.')}\n`);
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
  try {
    if (arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`A [[triggers]] "${slug}" already exists in kortix.toml.`)}\n`);
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
    } else if (tf.secretEnv) {
      fields.secret_env = tf.secretEnv;
    }
    fields.prompt = tf.prompt;
    appendArrayBlock('triggers', fields);
    process.stdout.write(
      `${status.ok(`Added [[triggers]] ${C.bold}${slug}${C.reset} (${type}) to kortix.toml`)} ${C.dim}— \`kortix ship\` to apply.${C.reset}\n`,
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
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.toml.`)}\n`);
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

// enabled is config — toggle it in the LOCAL kortix.toml `[[triggers]]` block
// (the source of truth), preserving the block's comments. `kortix ship` applies.
function triggersToggle(slug: string | undefined, enabled: boolean): number {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  try {
    if (!arrayEntryExists('triggers', 'slug', slug)) {
      process.stderr.write(`${status.err(`No [[triggers]] "${slug}" in kortix.toml.`)}\n`);
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

async function triggersInfo(slug: string | undefined, opts: CtxOpts): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(opts);
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

  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${t.name}${C.reset} ${C.faded}(${t.slug})${C.reset}\n`);
  process.stdout.write(`  ${C.dim}type        ${C.reset}${t.type}\n`);
  process.stdout.write(`  ${C.dim}enabled     ${C.reset}${t.enabled ? `${C.green}true${C.reset}` : `${C.faded}false${C.reset}`}\n`);
  process.stdout.write(`  ${C.dim}agent       ${C.reset}${t.agent}\n`);
  if (t.type === 'cron') {
    process.stdout.write(`  ${C.dim}cron        ${C.reset}${t.cron ?? '—'}\n`);
    process.stdout.write(`  ${C.dim}timezone    ${C.reset}${t.timezone}\n`);
  } else {
    process.stdout.write(`  ${C.dim}secret_env  ${C.reset}${t.secret_env ?? '—'}\n`);
    if (t.webhook_url) {
      process.stdout.write(`  ${C.dim}webhook_url ${C.reset}${t.webhook_url}\n`);
    }
  }
  process.stdout.write(`  ${C.dim}last_fired  ${C.reset}${t.last_fired_at ?? 'never'}\n`);
  process.stdout.write(`  ${C.dim}prompt      ${C.reset}${trimMid(t.prompt_template.replace(/\n/g, ' '), 80)}\n\n`);
  return 0;
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
