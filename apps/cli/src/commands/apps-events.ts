// `kortix apps events <app>` — the App's event log: what it posted and what
// came of each event (fired → session, skipped → why, unmatched → no trigger).

import type { AppEvent, AppEventStatus } from '@kortix/sdk';
import { emitJson, fail, takeFlagValue } from '../command-helpers.ts';
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
  const limit = positiveInteger(takeFlagValue(rest, ['--limit']), '--limit');
  const cursor = takeFlagValue(rest, ['--cursor']);
  const trigger = takeFlagValue(rest, ['--trigger']);
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
