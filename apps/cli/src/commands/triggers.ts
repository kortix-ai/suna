import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type {
  ProjectTrigger,
  ProjectTriggersResponse,
  TriggerFireResponse,
} from '../api/types.ts';

const HELP = `Usage: kortix triggers <subcommand> [options]

Manage the [[triggers]] declared in your project's kortix.toml.
Edits round-trip through the manifest — the dashboard sees the same
state.

Subcommands:
  ls                       List triggers + runtime state.
  fire <slug>              Manually fire a trigger now.
  enable <slug>            Set enabled = true on a trigger.
  disable <slug>           Set enabled = false on a trigger.
  info <slug>              Show one trigger in full.

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
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
      return triggersLs(ctxOpts);
    case 'fire':
      return triggersFire(rest[0], ctxOpts);
    case 'enable':
      return triggersToggle(rest[0], true, ctxOpts);
    case 'disable':
      return triggersToggle(rest[0], false, ctxOpts);
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

async function triggersToggle(
  slug: string | undefined,
  enabled: boolean,
  opts: CtxOpts,
): Promise<number> {
  if (!slug) {
    process.stderr.write(`${status.err('Pass a trigger slug.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  try {
    await ctx.client.patch(`/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}`, {
      enabled,
    });
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `${status.ok(`${enabled ? 'Enabled' : 'Disabled'} ${C.bold}${slug}${C.reset}`)}\n`,
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
