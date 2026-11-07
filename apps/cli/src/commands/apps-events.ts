// `kortix apps events <app>` — the App's event log: what it posted and what
// came of each event (fired → session, skipped → why, unmatched → no trigger).
// `kortix apps events emit <app> <name>` — a test event on the real path.
// `kortix apps events credentials <app>` — the URL and token the App posts with.

import type { AppEvent, AppEventStatus } from '@kortix/sdk';
import { emitJson, fail, takeFlagValue } from '../command-helpers.ts';
import { parsePayloadFlag } from './triggers-runs.ts';
import { C, pad, trim } from '../style.ts';
import { type ContextOptions, context, positiveInteger, resolveApp, scoped } from './apps-deploy.ts';

const STATUSES: readonly AppEventStatus[] = ['pending', 'fired', 'skipped', 'suppressed', 'failed', 'unmatched'];
const row = (cells: Array<[string, number]>) => `  ${cells.map(([text, width]) => pad(text, width)).join('')}`;
const dim = (text: string) => `${C.dim}${text}${C.reset}`;

/**
 * An App writes the event id and data, so a crafted value could carry
 * terminal escapes (move the cursor, retitle the window, fake a link) or
 * bidi overrides. Every App-written field is printed through this.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?');
}

/** The outcome, padded before it is colored so the columns stay aligned. */
function outcome(event: AppEvent, width: number): string {
  const text = pad(event.status, width);
  const color = event.status === 'fired' ? C.green : event.status === 'failed' ? C.red : event.status === 'pending' ? C.cyan : C.yellow;
  return `${color}${text}${C.reset}`;
}

/** What to read next to the outcome: the session it started, or why it did not run. */
function detail(event: AppEvent): string {
  if (event.session_id) return `session ${printable(event.session_id)}`;
  return printable(event.reason ?? '');
}

/** `HH:MM:SS` today, the date otherwise. */
function when(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? at.toTimeString().slice(0, 8) : at.toISOString().slice(0, 16).replace('T', ' ');
}

export async function eventsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  if (rest[0] === 'emit' || rest[0] === 'test') return emitCommand(rest.slice(1), options, json);
  if (rest[0] === 'credentials') return credentialsCommand(rest.slice(1), options, json);
  if (rest[0] === 'ls' || rest[0] === 'list') rest = rest.slice(1);
  return listCommand(rest, options, json);
}

async function listCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const limit = positiveInteger(takeFlagValue(rest, ['--limit']), '--limit');
  const cursor = takeFlagValue(rest, ['--cursor']);
  const trigger = takeFlagValue(rest, ['--trigger']);
  const eventId = takeFlagValue(rest, ['--id']);
  const wanted = takeFlagValue(rest, ['--status']);
  if (wanted !== undefined && !STATUSES.includes(wanted as AppEventStatus)) {
    return fail(`--status is one of ${STATUSES.join(', ')}`);
  }
  const [target] = rest.filter((value) => !value.startsWith('-'));
  if (!target) return fail('events needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const { app, page } = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    const listed = await ctx.apps.events.list(found.app_id, {
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
      ...(trigger ? { trigger } : {}),
      ...(eventId ? { id: eventId } : {}),
      ...(wanted ? { status: wanted as AppEventStatus } : {}),
    });
    return { app: found, page: listed };
  });
  if (json) {
    emitJson(page);
    return 0;
  }
  if (page.events.length === 0) {
    process.stdout.write(
      `\n  ${dim(`No events from ${app.slug} in the last 30 days${wanted ? ` with status ${wanted}` : ''}.`)}\n` +
        `  ${dim('An App posts with: curl -X POST "$KORTIX_APP_EVENTS_URL" -H "Authorization: Bearer $KORTIX_APP_TOKEN" -d \'{"name":"…"}\'')}\n\n`,
    );
    return 0;
  }
  process.stdout.write(`\n${row([['RECEIVED', 18], ['EVENT', 24], ['ID', 18], ['TRIGGER', 20], ['OUTCOME', 12], ['DETAIL', 0]])}\n`);
  for (const event of page.events) {
    process.stdout.write(
      `${row([
        [when(event.received_at), 18],
        [trim(printable(event.name ?? '(truncated)'), 23), 24],
        [trim(printable(event.id ?? '-'), 17), 18],
        [trim(printable(event.trigger ?? '-'), 19), 20],
      ])}${outcome(event, 12)}${detail(event)}\n`,
    );
  }
  if (page.next_cursor) {
    process.stdout.write(`\n  ${dim(`Older: kortix apps events ${app.slug} --cursor ${page.next_cursor}`)}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

const WAIT_DEFAULT_SECONDS = 60;
const WAIT_POLL_MS = 1_500;

/** `--wait` alone, or `--wait=<seconds>`. */
function takeWait(rest: string[]): number | null | { error: string } {
  const index = rest.findIndex((value) => value === '--wait' || value.startsWith('--wait='));
  if (index === -1) return null;
  const [flag] = rest.splice(index, 1);
  if (flag === '--wait') return WAIT_DEFAULT_SECONDS;
  const seconds = Number(flag!.slice('--wait='.length));
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 600 ? seconds : { error: '--wait=<seconds> is 1-600' };
}

/**
 * `kortix apps events emit <app> <name> [--data <json|@file>] [--id <id>] [--trigger <slug>] [--wait[=s]]`.
 * `--trigger`: only that trigger gets the test, so testing one automation starts no other.
 * With --wait it reads the log until no row of the test is pending, prints the
 * outcome per trigger, and exits 0 only when a trigger fired.
 */
async function emitCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const wait = takeWait(rest);
  if (wait && typeof wait === 'object') return fail(wait.error);
  const rawData = takeFlagValue(rest, ['--data']);
  const id = takeFlagValue(rest, ['--id']);
  const trigger = takeFlagValue(rest, ['--trigger']);
  const data = rawData === undefined ? undefined : parsePayloadFlag(rawData);
  if (data && 'error' in data) return fail(data.error.replaceAll('--payload', '--data'));
  const [target, name] = rest.filter((value) => !value.startsWith('-'));
  if (!target || !name) return fail('usage: kortix apps events emit <app> <event-name> [--data <json|@file>] [--id <id>] [--trigger <slug>] [--wait]');
  const ctx = await context(options);
  if (!ctx) return 1;
  const { app, sent } = await scoped(ctx, async () => {
    const found = await resolveApp(ctx.apps, target);
    const answer = await ctx.apps.events.test(found.app_id, { name, ...(data ? { data: data.value } : {}), ...(id ? { id } : {}), ...(trigger ? { trigger } : {}) });
    return { app: found, sent: answer };
  });
  const testId = sent.ids[0]!;
  if (!wait) {
    if (json) emitJson(sent);
    else {
      process.stdout.write(`\n  Sent ${name} (${printable(testId)}) to ${app.slug}: ${sent.triggers} trigger(s) listen.\n`);
      if (sent.hint) process.stdout.write(`  ${C.yellow}${printable(sent.hint)}${C.reset}\n`);
      process.stdout.write(`  ${dim(`Outcome: kortix apps events ${app.slug} --id ${printable(testId)}`)}\n\n`);
    }
    return 0;
  }
  const deadline = Date.now() + wait * 1000;
  let rows: AppEvent[] = [];
  for (;;) {
    // The same --id may have an older row of the other kind (unmatched before a
    // trigger existed): keep only the rows this send can have written.
    rows = (await scoped(ctx, () => ctx.apps.events.list(app.app_id, { id: testId, limit: 50 }))).events.filter((row) =>
      sent.triggers > 0 ? row.trigger !== null : row.status === 'unmatched',
    );
    if (rows.length > 0 && rows.every((row) => row.status !== 'pending')) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, WAIT_POLL_MS));
  }
  const fired = rows.some((row) => row.status === 'fired');
  const pending = rows.some((row) => row.status === 'pending');
  if (json) {
    emitJson({ ...sent, events: rows, fired, pending });
  } else {
    process.stdout.write(`\n  Sent ${name} (${printable(testId)}) to ${app.slug}.\n`);
    for (const row of rows) {
      process.stdout.write(`  ${pad(printable(row.trigger ?? '-'), 24)}${outcome(row, 12)}${detail(row)}\n`);
    }
    if (pending) process.stdout.write(`  ${dim(`Still pending after ${wait} s: Kortix has not drained it yet. Check again: kortix apps events ${app.slug} --id ${testId}`)}\n`);
    process.stdout.write('\n');
  }
  return fired ? 0 : 1;
}

/** `kortix apps events credentials <app>`: the URL and token, for code that runs outside the App. */
async function credentialsCommand(rest: string[], options: ContextOptions, json: boolean): Promise<number> {
  const [target] = rest.filter((value) => !value.startsWith('-'));
  if (!target) return fail('credentials needs an App id or slug');
  const ctx = await context(options);
  if (!ctx) return 1;
  const credentials = await scoped(ctx, async () => ctx.apps.events.credentials((await resolveApp(ctx.apps, target)).app_id));
  if (json) {
    emitJson(credentials);
    return 0;
  }
  process.stderr.write(`  ${C.yellow}The token posts events as this App. Keep it out of chat, files and commits.${C.reset}\n`);
  process.stdout.write(`KORTIX_APP_EVENTS_URL=${credentials.url}\nKORTIX_APP_TOKEN=${credentials.token}\n`);
  return 0;
}
