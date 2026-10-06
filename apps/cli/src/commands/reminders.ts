/**
 * `kortix reminders` (and the `kortix remind` shortcut) — scheduled prompts
 * into one session.
 *
 * A reminder is a trigger scoped to one session and stored in the database,
 * not kortix.yaml. It re-prompts its session at the scheduled time(s) until
 * someone removes it. Inside a sandbox `--session` defaults to
 * $KORTIX_SESSION_ID, so an agent schedules its own follow-up with one command.
 */
import type { SessionReminder } from '@kortix/sdk';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  expandSessionIdPrefix,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix reminders <subcommand> [options]
       kortix remind "<prompt>" [schedule]        (= reminders add)

Reminders are a per-project feature flag, off by default. Turn them on with
\`kortix projects features enable reminders\` (or Settings → Feature flags).

A reminder re-prompts ONE session on a schedule — "in 24h, check whether the
email arrived", "every hour until the deploy is green". It is a trigger scoped
to that session and stored in the database, not kortix.yaml: no commit, no
review, gone when you remove it. Each fire wakes the session (parked or not)
with the reminder text. A fire never starts a new session; if the session is
deleted or failed, the reminder pauses itself.

Subcommands:
  add "<prompt>" [schedule]   Create a reminder. Prints its id.
  ls                          List this session's reminders.
  pause <id>                  Stop firing, keep the reminder.
  resume <id>                 Fire again, re-armed from now.
  rm <id>                     Delete the reminder (aliases: stop, delete).

Schedule (add):
  --in <duration>     First fire after this long: 30m, 24h, 2d.
  --at <iso>          First fire at this instant (ISO 8601).
  --every <duration>  Repeat on this period (min 5m, max 366d) until removed.
  --cron "<expr>"     Repeat on a cron expression (6-field, seconds first).
  --timezone <tz>     IANA timezone for --cron (default UTC).
  --in/--at alone fires once. Add --every to keep repeating after that.

Options:
  --name <text>       Label shown in \`ls\`.
  --session <id>      Target session (default: $KORTIX_SESSION_ID inside a
                      session). A unique id prefix works.
  --project <id>      Project (default: linked or $KORTIX_PROJECT_ID).
  --host <name>       Operate against a non-default Kortix host.
  --json              Machine-readable output.
  -h, --help          Show this help.

Examples:
  kortix remind "Did the email to the vendor arrive? If yes, stop this reminder." --in 24h --every 1h
  kortix remind "Re-run the flaky test suite and report" --at 2026-10-01T09:00:00Z
  kortix reminders add "Post the standup summary" --cron "0 0 9 * * 1-5" --timezone Europe/Berlin
  kortix reminders ls
  kortix reminders rm reminder.3f9a1c2e7b04
`;

function describeSchedule(r: SessionReminder): string {
  if (r.cron) return `cron ${r.cron} ${r.timezone}`;
  if (r.every) return `every ${r.every}`;
  return 'once';
}

function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

function writeReminder(r: SessionReminder, heading: string): void {
  // A fired one-shot reminder stays done on resume; do not say it resumed.
  const done = heading === 'Resumed' && r.state === 'done';
  process.stdout.write(`\n${done ? status.warn(`${r.id} already fired and stays done. Create a new reminder to fire again.`) : status.ok(`${heading} ${C.bold}${r.id}${C.reset}`)}\n`);
  process.stdout.write(`  ${C.dim}session ${C.reset}${r.session_id ?? '—'}\n`);
  process.stdout.write(`  ${C.dim}repeat  ${C.reset}${describeSchedule(r)}\n`);
  process.stdout.write(`  ${C.dim}state   ${C.reset}${r.state}\n`);
  process.stdout.write(`  ${C.dim}next    ${C.reset}${formatInstant(r.next_fire_at)}\n`);
  if (r.last_fired_at) process.stdout.write(`  ${C.dim}last    ${C.reset}${formatInstant(r.last_fired_at)}\n`);
  if (r.state !== 'done') {
    process.stdout.write(`  ${C.dim}remove  ${C.reset}kortix reminders rm ${r.id}\n`);
  }
  process.stdout.write('\n');
}

export async function runReminders(argv: string[], shortcut = false): Promise<number> {
  const help = splitHelp(argv, HELP);
  if (help !== null) return help;
  const rest = [...argv];

  let flags: Record<string, string | undefined>;
  let json = false;
  try {
    flags = {
      in: takeFlagValue(rest, ['--in']),
      at: takeFlagValue(rest, ['--at']),
      every: takeFlagValue(rest, ['--every']),
      cron: takeFlagValue(rest, ['--cron']),
      timezone: takeFlagValue(rest, ['--timezone', '--tz']),
      name: takeFlagValue(rest, ['--name']),
      session: takeFlagValue(rest, ['--session']),
      project: takeFlagValue(rest, ['--project']),
      host: takeFlagValue(rest, ['--host']),
    };
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }

  const sub = shortcut ? 'add' : rest.shift();
  const args = rest;
  if (!['add', 'create', 'ls', 'list', 'pause', 'resume', 'rm', 'stop', 'delete', 'remove'].includes(sub ?? '')) {
    return fail(`Unknown subcommand "${sub}". Run \`kortix reminders --help\`.`);
  }

  let sessionRef = flags.session ?? process.env.KORTIX_SESSION_ID;
  if (!sessionRef) return missing('--session <id>. Inside a session it defaults to $KORTIX_SESSION_ID');

  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;
  const { client, projectId } = ctx;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(sessionRef)) {
    const hit = await expandSessionIdPrefix(client, projectId, sessionRef);
    if (hit === 'ambiguous') {
      process.stderr.write(`${status.err(`Several sessions match "${sessionRef}" — use more of the id.`)}\n`);
      return 1;
    }
    if (hit) sessionRef = hit.session_id;
  }
  const base = `/projects/${projectId}/sessions/${sessionRef}/reminders`;

  try {
    if (sub === 'add' || sub === 'create') {
      const prompt = args.join(' ').trim();
      if (!prompt) return missing('the reminder text, e.g. kortix remind "Did it arrive?" --in 24h');
      const body: Record<string, string> = { prompt };
      for (const key of ['in', 'at', 'every', 'cron', 'timezone', 'name'] as const) {
        if (flags[key] !== undefined) body[key] = flags[key]!;
      }
      const created = await client.post<SessionReminder>(base, body);
      if (json) emitJson(created);
      else writeReminder(created, 'Reminder set');
      return 0;
    }

    if (sub === 'ls' || sub === 'list') {
      const { reminders } = await client.get<{ reminders: SessionReminder[] }>(base);
      if (json) {
        emitJson({ reminders });
        return 0;
      }
      if (reminders.length === 0) {
        process.stdout.write(`  ${C.dim}No reminders on this session.${C.reset}\n`);
        return 0;
      }
      const idW = Math.max(...reminders.map((r) => r.id.length), 2);
      const nameW = Math.max(...reminders.map((r) => (r.name ?? '—').length), 4);
      process.stdout.write(`\n  ${C.dim}${pad('ID', idW)}   STATE    ${pad('REPEAT', 24)}  NEXT                  LAST FIRED            ${pad('NAME', nameW)}  TEXT${C.reset}\n`);
      for (const r of reminders) {
        const text = r.prompt.replace(/\s+/g, ' ');
        process.stdout.write(
          `  ${pad(r.id, idW)}   ${pad(r.state, 7)}  ${pad(describeSchedule(r).slice(0, 24), 24)}  ${pad(formatInstant(r.next_fire_at), 20)}  ${pad(formatInstant(r.last_fired_at), 20)}  ${pad(r.name ?? '—', nameW)}  ${text.length > 60 ? `${text.slice(0, 59)}…` : text}\n`,
        );
        if (r.last_error) process.stdout.write(`  ${' '.repeat(idW)}   ${C.red}${r.last_error}${C.reset}\n`);
      }
      process.stdout.write('\n');
      return 0;
    }

    const id = args[0];
    if (!id) return missing(`a reminder id: kortix reminders ${sub} <id>`);
    if (sub === 'pause' || sub === 'resume') {
      const updated = await client.patch<SessionReminder>(`${base}/${id}`, { enabled: sub === 'resume' });
      if (json) emitJson(updated);
      else writeReminder(updated, sub === 'pause' ? 'Paused' : 'Resumed');
      return 0;
    }
    await client.delete<{ ok: boolean }>(`${base}/${id}`);
    if (json) emitJson({ ok: true, id });
    else process.stdout.write(`${status.ok(`Removed ${id}`)}\n`);
    return 0;
  } catch (err) {
    const code = surfaceApiError(err);
    if ((err as { body?: { code?: unknown } })?.body?.code === 'feature_disabled') {
      process.stderr.write(`  ${C.dim}Turn it on: kortix projects features enable reminders${C.reset}\n`);
    }
    return code;
  }
}
