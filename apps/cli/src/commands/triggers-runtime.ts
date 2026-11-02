/**
 * The runtime half of `kortix triggers`: a trigger is a source (what fires it)
 * plus a target (what a fire does). A kortix.yaml trigger changes through the
 * manifest (`triggers.ts`). A runtime trigger lives in the database: `add` with
 * a runtime flag creates one, and pause/resume/run/rm take its id
 * (`trigger.<hex>`, `reminder.<hex>`, or a pre-rename `automation.<hex>`).
 * `kortix automations` is a hidden alias of `kortix triggers`.
 */
import type { CreateRuntimeTriggerInput, TriggerSource, TriggerTarget, UnifiedTrigger, UnifiedTriggerList } from '@kortix/sdk';
import type { ApiClient } from '../api/client.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

export const RUNTIME_HELP = `Runtime triggers (no kortix.yaml commit):
  add "<prompt>" --on <source> | --session <id> | --runtime [options]
                           Create a runtime trigger. Prints its id.
  pause|resume <id>        Stop or restart firing.
  run <id>                 Fire once now.
  rm <id>                  Delete it.
  ls                       Also lists them, under "Created at runtime".
  <id> is trigger.<hex> or reminder.<hex> (a loop).

Runtime source (add):
  --every <dur> | --cron "<expr>" [--timezone <tz>] | --at <iso> | --in <dur>
                           A schedule (the default source).
  --on webhook --secret-env <NAME>
                           A signed HTTP call. POST to the printed webhook_url.
  --on event --connector <slug> --event <TYPE> [--config <json>]
                           A connector event.
  --on app --app <slug>    An event an App of this project emits.
  --on cr-merged [--cr <id>] [--base <branch>]
                           A merged change request: one (--cr), any into a
                           branch (--base), or any.

Runtime target (add):
  --session <id>           Wake this session (default: $KORTIX_SESSION_ID).
                           A trigger that wakes its own session is a loop.
  --agent <name>           Start a new session of this agent on each fire.

Examples:
  kortix triggers add "Did the deploy go green?" --runtime --every 1h
  kortix triggers add "CR merged: verify prod" --on cr-merged --cr 42
  kortix triggers add "Triage {{ body.issue.title }}" --on webhook --secret-env ISSUE_SECRET --agent triage
  kortix triggers rm trigger.3f9a1c2e7b04`;

export const RUNTIME_ID = /^(?:reminder|trigger|automation)\.[0-9a-f]{12}$/;

/** `add` creates a runtime trigger when one of these flags is present; else it edits kortix.yaml. */
const RUNTIME_ADD_FLAGS = ['--runtime', '--on', '--source-type', '--session', '--in', '--at'];
export function isRuntimeAdd(argv: string[]): boolean {
  return argv.some((arg) => RUNTIME_ADD_FLAGS.includes(arg.split('=')[0]!));
}

export function describeSource(source: TriggerSource): string {
  switch (source.type) {
    case 'schedule':
      return source.cron ? `cron ${source.cron}` : source.every ? `every ${source.every}` : `once ${source.at ?? ''}`.trim();
    case 'webhook':
      return 'webhook';
    case 'event':
      return `event ${source.connector ?? ''} ${source.event ?? ''}`.trim();
    case 'app':
      return `app ${source.app ?? ''}`.trim();
    case 'change_request':
      return source.cr_id ? `cr merged ${source.cr_id}` : source.base ? `cr merged into ${source.base}` : 'cr merged';
  }
}

export function describeTarget(target: TriggerTarget): string {
  if (target.kind === 'agent') return `agent ${target.agent}`;
  if (target.kind === 'app') return `app ${target.app}`;
  return `session ${target.session_name || target.session_id.slice(0, 8)}`;
}

const instant = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');

/** The runtime rows of `GET /triggers/all`, or null when the server has no such route. */
export async function listRuntimeTriggers(client: ApiClient, projectId: string): Promise<UnifiedTrigger[] | null> {
  try {
    const list = await client.get<UnifiedTriggerList>(`/projects/${projectId}/triggers/all`);
    return list.triggers.filter((t) => t.origin === 'runtime');
  } catch {
    // ponytail: an older API has no /triggers/all; `ls` then shows kortix.yaml only.
    return null;
  }
}

/** The "Created at runtime" table under `kortix triggers ls`. */
export function printRuntimeTriggers(rows: UnifiedTrigger[]): void {
  if (rows.length === 0) return;
  const listed = rows.map((t) => ({ t, source: describeSource(t.source), target: describeTarget(t.target) }));
  const w = (pick: (r: (typeof listed)[number]) => string, min: number, max: number) =>
    Math.min(Math.max(min, ...listed.map((r) => pick(r).length)), max);
  const idW = w((r) => r.t.id, 2, 64);
  const srcW = w((r) => r.source, 6, 32);
  const tgtW = w((r) => r.target, 6, 32);
  process.stdout.write(`\n  Created at runtime\n`);
  process.stdout.write(`  ${C.dim}${pad('ID', idW)}  ${pad('SOURCE', srcW)}  ${pad('TARGET', tgtW)}  STATE    NEXT                  LAST FIRED${C.reset}\n`);
  for (const r of listed) {
    process.stdout.write(
      `  ${pad(r.t.id, idW)}  ${pad(r.source.slice(0, srcW), srcW)}  ${pad(r.target.slice(0, tgtW), tgtW)}  ${pad(r.t.state, 7)}  ${pad(instant(r.t.next_fire_at), 20)}  ${instant(r.t.last_fired_at)}\n`,
    );
    if (r.t.last_error) process.stdout.write(`  ${' '.repeat(idW)}  ${C.red}${r.t.last_error}${C.reset}\n`);
  }
  process.stdout.write(`\n  ${C.dim}${rows.length} runtime trigger${rows.length === 1 ? '' : 's'}${C.reset}\n`);
}

/** The source of `add`, or an error. A schedule flag alone means the schedule source. */
function sourceOf(flags: Record<string, string | undefined>): CreateRuntimeTriggerInput['source'] | string {
  const on = flags.on ?? 'schedule';
  if (on === 'schedule') {
    const schedule: Record<string, string> = {};
    for (const key of ['every', 'cron', 'at', 'in', 'timezone'] as const) if (flags[key] !== undefined) schedule[key] = flags[key]!;
    if (!schedule.every && !schedule.cron && !schedule.at && !schedule.in) return 'a schedule (--every, --cron, --at or --in) or --on <source>';
    return { type: 'schedule', ...schedule };
  }
  if (on === 'webhook') return flags.secretEnv ? { type: 'webhook', secret_env: flags.secretEnv } : '--secret-env <NAME> for --on webhook';
  if (on === 'event') {
    if (!flags.connector || !flags.event) return '--connector <slug> and --event <TYPE> for --on event';
    let config: Record<string, unknown> | undefined;
    if (flags.config) {
      try {
        config = JSON.parse(flags.config) as Record<string, unknown>;
      } catch {
        return '--config as a JSON object';
      }
    }
    return { type: 'event', connector: flags.connector, event: flags.event, ...(config ? { config } : {}) };
  }
  if (on === 'app') return flags.app ? { type: 'app', app: flags.app } : '--app <slug> for --on app';
  if (on === 'cr-merged' || on === 'change_request') {
    return { type: 'change_request', ...(flags.cr ? { cr_id: flags.cr } : {}), ...(flags.base ? { base: flags.base } : {}) };
  }
  return `--on schedule, webhook, event, app or cr-merged (got "${on}")`;
}

/** `add` (runtime), or pause/resume/run/rm on a runtime id. */
export async function runRuntimeTriggers(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  let flags: Record<string, string | undefined>;
  let json = false;
  try {
    takeFlagBool(rest, ['--runtime']);
    flags = {
      on: takeFlagValue(rest, ['--on', '--source-type']),
      every: takeFlagValue(rest, ['--every']),
      cron: takeFlagValue(rest, ['--cron']),
      at: takeFlagValue(rest, ['--at']),
      in: takeFlagValue(rest, ['--in']),
      timezone: takeFlagValue(rest, ['--timezone', '--tz']),
      secretEnv: takeFlagValue(rest, ['--secret-env']),
      connector: takeFlagValue(rest, ['--connector']),
      event: takeFlagValue(rest, ['--event']),
      config: takeFlagValue(rest, ['--config']),
      app: takeFlagValue(rest, ['--app']),
      cr: takeFlagValue(rest, ['--cr']),
      base: takeFlagValue(rest, ['--base']),
      session: takeFlagValue(rest, ['--session']),
      agent: takeFlagValue(rest, ['--agent']),
      name: takeFlagValue(rest, ['--name']),
      project: takeFlagValue(rest, ['--project']),
      host: takeFlagValue(rest, ['--host']),
    };
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }

  let body: CreateRuntimeTriggerInput | null = null;
  if (sub === 'add' || sub === 'create') {
    const prompt = rest.join(' ').trim();
    if (!prompt) return missing('the prompt, e.g. kortix triggers add "Did it arrive?" --in 24h');
    const source = sourceOf(flags);
    if (typeof source === 'string') return missing(source);
    if (flags.session && flags.agent) return fail('Pass --session or --agent, not both.');
    const sessionId = flags.agent ? undefined : (flags.session ?? process.env.KORTIX_SESSION_ID);
    if (!flags.agent && !sessionId) return missing('a target: --agent <name>, or --session <id> (inside a session it defaults to $KORTIX_SESSION_ID)');
    body = {
      prompt,
      ...(flags.name ? { name: flags.name } : {}),
      source,
      target: flags.agent ? { agent: flags.agent } : { session_id: sessionId! },
    };
  }

  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  const { client, projectId } = ctx;
  const base = `/projects/${projectId}/triggers/runtime`;
  try {
    if (body) {
      const created = await client.post<UnifiedTrigger>(base, body);
      if (json) {
        emitJson(created);
        return 0;
      }
      process.stdout.write(`\n${status.ok(`Trigger set ${C.bold}${created.id}${C.reset}`)}\n`);
      process.stdout.write(`  ${C.dim}source  ${C.reset}${describeSource(created.source)}\n`);
      process.stdout.write(`  ${C.dim}target  ${C.reset}${describeTarget(created.target)}\n`);
      if (created.source.webhook_url) process.stdout.write(`  ${C.dim}url     ${C.reset}${created.source.webhook_url}\n`);
      process.stdout.write(`  ${C.dim}remove  ${C.reset}kortix triggers rm ${created.id}\n\n`);
      return 0;
    }
    const id = rest[0]!;
    const path = `${base}/${encodeURIComponent(id)}`;
    if (sub === 'pause' || sub === 'resume' || sub === 'disable' || sub === 'enable') {
      const updated = await client.patch<UnifiedTrigger>(path, { enabled: sub === 'resume' || sub === 'enable' });
      if (json) {
        emitJson(updated);
        return 0;
      }
      process.stdout.write(`${status.ok(`${updated.state === 'paused' ? 'Paused' : 'Resumed'} ${id} (${updated.state})`)}\n`);
      return 0;
    }
    if (sub === 'run' || sub === 'fire') {
      const ran = await client.post<UnifiedTrigger>(`${path}/run`, {});
      if (json) {
        emitJson(ran);
        return 0;
      }
      process.stdout.write(`${status.ok(`Fired ${id}`)}\n`);
      return 0;
    }
    await client.delete<{ ok: boolean }>(path);
    if (json) {
      emitJson({ ok: true, id });
      return 0;
    }
    process.stdout.write(`${status.ok(`Removed ${id}`)}\n`);
    return 0;
  } catch (err) {
    const code = surfaceApiError(err);
    if ((err as { body?: { code?: unknown } })?.body?.code === 'feature_disabled') {
      process.stderr.write(`  ${C.dim}Turn it on: kortix projects features enable reminders${C.reset}\n`);
    }
    return code;
  }
}
