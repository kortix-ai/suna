/**
 * `kortix automations` — triggers and loops as one concept: a source (what fires
 * it) plus a target (what a fire does). `ls` lists both stores; `add` creates a
 * runtime automation; pause/resume/run/rm take a runtime id here and hand a
 * kortix.yaml slug to `kortix triggers`. Every other subcommand is `kortix
 * triggers` (kortix.yaml editing, runs, replay). `kortix triggers`, `kortix loop`
 * and `kortix loops` stay, with the same flags.
 */
import type { Automation, AutomationSource, AutomationTarget, CreateProjectAutomationInput } from '@kortix/sdk';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { runTriggers } from './triggers.ts';

const HELP = help`Usage: kortix automations <subcommand> [options]

An automation is a source plus a target.
  Sources: a schedule (--every, --cron, --at, --in), a webhook, a connector
           event, an App event, or a merged change request.
  Targets: a session (wake it with the prompt: a loop) or an agent (start a
           new session of it on each fire).
A kortix.yaml automation is declared under \`triggers:\` and changes through a
commit. A runtime one lives in the database: no commit, gone when you remove it.

Subcommands:
  ls                          Every automation: kortix.yaml and runtime.
  add "<prompt>" [options]    Create a runtime automation. Prints its id.
  pause|resume <id>           Stop or restart firing.
  run <id>                    Fire once now.
  rm <id>                     Delete it.
  <anything else>             Runs \`kortix triggers <subcommand>\` (kortix.yaml).
  pause/resume/run/rm on a kortix.yaml slug run \`kortix triggers
  disable/enable/fire/rm <slug>\` (local manifest edits; --apply for the cloud).

Source (add):
  --every <dur> | --cron "<expr>" [--timezone <tz>] | --at <iso> | --in <dur>
                              A schedule (the default source).
  --on webhook --secret-env <NAME>
                              A signed HTTP call. POST to the printed webhook_url.
  --on event --connector <slug> --event <TYPE> [--config <json>]
                              A connector event.
  --on app --app <slug>       An event an App of this project emits.
  --on cr-merged [--cr <id>] [--base <branch>]
                              A merged change request: one (--cr), any into a
                              branch (--base), or any.

Target (add):
  --session <id>              Wake this session (default: $KORTIX_SESSION_ID).
  --agent <name>              Start a new session of this agent on each fire.

Options:
  --name <text>  --project <id>  --host <name>  --json  -h, --help

Aliases: \`kortix triggers\` (kortix.yaml), \`kortix loop\` / \`kortix loops\`
(a schedule into a session) keep their flags.

Examples:
  kortix automations ls
  kortix automations add "Did the deploy go green?" --every 1h
  kortix automations add "CR merged: verify prod" --on cr-merged --cr 42
  kortix automations add "Triage {{ body.issue.title }}" --on webhook --secret-env ISSUE_SECRET --agent triage
  kortix automations rm automation.3f9a1c2e7b04
`;

const RUNTIME_ID = /^(?:reminder|automation)\.[0-9a-f]{12}$/;
/** pause/resume/run/rm on a kortix.yaml slug, as `kortix triggers` names them. */
const DECLARED_VERB: Record<string, string> = { pause: 'disable', resume: 'enable', run: 'fire', rm: 'rm', stop: 'rm', delete: 'rm', remove: 'rm' };

function describeSource(source: AutomationSource): string {
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

function describeTarget(target: AutomationTarget): string {
  if (target.kind === 'agent') return `agent ${target.agent}`;
  if (target.kind === 'app') return `app ${target.app}`;
  return `session ${target.session_name || target.session_id.slice(0, 8)}`;
}

const instant = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');

/** The source of `add`, or an error. A schedule flag alone means the schedule source. */
function sourceOf(flags: Record<string, string | undefined>): CreateProjectAutomationInput['source'] | string {
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

export async function runAutomations(argv: string[]): Promise<number> {
  const help = splitHelp(argv, HELP);
  if (help !== null) return help;
  const sub = argv[0];
  const isRuntimeOp = !!sub && sub in DECLARED_VERB && RUNTIME_ID.test(argv[1] ?? '');
  // A kortix.yaml slug, or a bare `pause`/`resume` (the project-wide switch): `kortix triggers`.
  if (sub && sub !== 'ls' && sub !== 'list' && sub !== 'add' && sub !== 'create' && !isRuntimeOp) {
    const verb = argv[1] && !argv[1].startsWith('-') ? DECLARED_VERB[sub] : undefined;
    return runTriggers(verb ? [verb, ...argv.slice(1)] : argv);
  }

  const rest = argv.slice(1);
  let flags: Record<string, string | undefined>;
  let json = false;
  try {
    flags = {
      on: takeFlagValue(rest, ['--on', '--source']),
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

  let body: CreateProjectAutomationInput | null = null;
  if (sub === 'add' || sub === 'create') {
    const prompt = rest.join(' ').trim();
    if (!prompt) return missing('the prompt, e.g. kortix automations add "Did it arrive?" --in 24h');
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
  const base = `/projects/${projectId}/automations`;
  try {
    if (body) {
      const created = await client.post<Automation & { source: AutomationSource & { webhook_url?: string } }>(base, body);
      if (json) {
        emitJson(created);
        return 0;
      }
      process.stdout.write(`\n${status.ok(`Automation set ${C.bold}${created.id}${C.reset}`)}\n`);
      process.stdout.write(`  ${C.dim}source  ${C.reset}${describeSource(created.source)}\n`);
      process.stdout.write(`  ${C.dim}target  ${C.reset}${describeTarget(created.target)}\n`);
      if (created.source.webhook_url) process.stdout.write(`  ${C.dim}url     ${C.reset}${created.source.webhook_url}\n`);
      process.stdout.write(`  ${C.dim}remove  ${C.reset}kortix automations rm ${created.id}\n\n`);
      return 0;
    }
    if (!sub || sub === 'ls' || sub === 'list') {
      const list = await client.get<{ automations: Automation[] }>(base);
      if (json) {
        emitJson(list);
        return 0;
      }
      if (list.automations.length === 0) {
        process.stdout.write(`  ${C.dim}No automations in this project.${C.reset}\n`);
        return 0;
      }
      const rows = list.automations.map((a) => ({
        a,
        origin: a.origin === 'declared' ? 'kortix.yaml' : 'runtime',
        source: describeSource(a.source),
        target: describeTarget(a.target),
      }));
      const w = (pick: (r: (typeof rows)[number]) => string, min: number) => Math.max(min, ...rows.map((r) => pick(r).length));
      const idW = w((r) => r.a.id, 2);
      const srcW = Math.min(w((r) => r.source, 6), 32);
      const tgtW = Math.min(w((r) => r.target, 6), 32);
      process.stdout.write(`\n  ${C.dim}${pad('ID', idW)}  ${pad('ORIGIN', 11)}  ${pad('SOURCE', srcW)}  ${pad('TARGET', tgtW)}  STATE    NEXT                  LAST FIRED${C.reset}\n`);
      for (const r of rows) {
        process.stdout.write(
          `  ${pad(r.a.id, idW)}  ${pad(r.origin, 11)}  ${pad(r.source.slice(0, srcW), srcW)}  ${pad(r.target.slice(0, tgtW), tgtW)}  ${pad(r.a.state, 7)}  ${pad(instant(r.a.next_fire_at), 20)}  ${instant(r.a.last_fired_at)}\n`,
        );
        if (r.a.last_error) process.stdout.write(`  ${' '.repeat(idW)}  ${C.red}${r.a.last_error}${C.reset}\n`);
      }
      process.stdout.write('\n');
      return 0;
    }
    const id = rest[0]!;
    const path = `${base}/${encodeURIComponent(id)}`;
    if (sub === 'pause' || sub === 'resume') {
      const updated = await client.patch<Automation>(path, { enabled: sub === 'resume' });
      if (json) {
        emitJson(updated);
        return 0;
      }
      process.stdout.write(`${status.ok(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${id} (${updated.state})`)}\n`);
      return 0;
    }
    if (sub === 'run') {
      const ran = await client.post<Automation>(`${path}/run`, {});
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
