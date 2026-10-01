/**
 * `kortix capture` — read the screen history of the person you act for.
 *
 * Kortix Capture records a person's own screen (apps, window titles, URLs,
 * on-screen text, timestamps) on their machine. These commands search it.
 * Inside a session sandbox the token acts for the person the session runs
 * for, in that project's account. Logged in as a user, it is you. Never
 * another member. The data is personal: read what the task needs, no more.
 */
import {
  getProjectCaptureFrame,
  getProjectCaptureTimeline,
  searchProjectCapture,
  type CaptureSearchOptions,
} from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
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
import { C, help, pad } from '../style.ts';

const HELP = help`Usage: kortix capture <subcommand> [options]

Search the screen history Kortix Capture recorded for the person you act for:
apps, window titles, URLs, on-screen text and timestamps. Inside a session it
reads the history of the person the session runs for. It never reads another
member's history. Without a person (a trigger run, a shared session) or with
capture turned off for that person, the command fails with a 403.

Subcommands:
  search <query>    Full-text search, newest first.
  timeline          Recorded spans and time per app for one day.
  frame <id>        One frame with its full on-screen text.

Options:
  --from <iso>      search, timeline: start (ISO 8601 or YYYY-MM-DD).
  --to <iso>        search, timeline: end (exclusive).
  --day <date>      timeline: one local day, YYYY-MM-DD (default: today).
  --app <name>      search: only this app (exact, any case).
  --domain <host>   search: only this website domain.
  --limit <n>       search: results, 1 to 100 (default 20).
  --project <id>    Project (default: linked or $KORTIX_PROJECT_ID).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Examples:
  kortix capture search "invoice" --from 2026-10-01 --app Safari
  kortix capture timeline --day 2026-10-01
  kortix capture frame 4821 --json
`;

const strip = (html: string) => html.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').trim();

/** `YYYY-MM-DD` is the local day; anything else passes through for the API to parse. */
function dayRange(day: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

export async function runCapture(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];

  let f: Record<string, string | undefined>;
  let json = false;
  try {
    f = {
      from: takeFlagValue(rest, ['--from']),
      to: takeFlagValue(rest, ['--to']),
      day: takeFlagValue(rest, ['--day']),
      app: takeFlagValue(rest, ['--app']),
      domain: takeFlagValue(rest, ['--domain']),
      limit: takeFlagValue(rest, ['--limit']),
      project: takeFlagValue(rest, ['--project']),
      host: takeFlagValue(rest, ['--host']),
    };
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const sub = rest.shift();
  if (!['search', 'timeline', 'frame'].includes(sub ?? '')) {
    return fail(`Unknown subcommand "${sub ?? ''}". Run \`kortix capture --help\`.`);
  }
  const limit = f.limit === undefined ? undefined : Number(f.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return fail('--limit must be an integer from 1 to 100.');
  }
  const query = sub === 'search' ? rest.join(' ').trim() : '';
  if (sub === 'search' && !query) return missing('a search query, e.g. kortix capture search "invoice"');
  const frameId = Number(rest[0]);
  if (sub === 'frame' && !(Number.isSafeInteger(frameId) && frameId > 0)) return missing('a frame id: kortix capture frame <id>');
  let range: { from?: string; to?: string } = { from: f.from, to: f.to };
  if (sub === 'timeline') {
    const day = dayRange(f.day ?? new Date().toLocaleDateString('sv'));
    if (!day) return fail('--day must be YYYY-MM-DD.');
    if (!f.from && !f.to) range = day;
  }

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const { auth, projectId } = ctx;
  try {
    if (sub === 'search') {
      const options: Omit<CaptureSearchOptions, 'user_id'> = { q: query, from: f.from, to: f.to, app: f.app, domain: f.domain, limit };
      const page = await withKortixScope(auth, () => searchProjectCapture(projectId, options));
      if (json) return (emitJson(page), 0);
      if (page.items.length === 0) {
        process.stdout.write(`  ${C.dim}No matches.${C.reset}\n`);
        return 0;
      }
      for (const item of page.items) {
        process.stdout.write(
          `\n  ${C.dim}#${item.frame_id}  ${item.ts}${C.reset}  ${C.bold}${item.app_name ?? '-'}${C.reset}  ${item.window_title ?? ''}\n`,
        );
        if (item.url) process.stdout.write(`    ${C.dim}${item.url}${C.reset}\n`);
        if (item.snippet.trim()) process.stdout.write(`    ${strip(item.snippet)}\n`);
      }
      if (page.next_cursor) process.stdout.write(`\n  ${C.dim}More results exist: narrow with --from/--to/--app or raise --limit.${C.reset}\n`);
      process.stdout.write('\n');
      return 0;
    }
    if (sub === 'timeline') {
      const timeline = await withKortixScope(auth, () => getProjectCaptureTimeline(projectId, range));
      if (json) return (emitJson(timeline), 0);
      if (timeline.chunks.length === 0) {
        process.stdout.write(`  ${C.dim}Nothing recorded in this range.${C.reset}\n`);
        return 0;
      }
      process.stdout.write(`\n  ${C.dim}APP${' '.repeat(29)}TIME${C.reset}\n`);
      for (const a of timeline.apps) {
        process.stdout.write(`  ${pad(a.app_name, 32)}${Math.round(a.seconds / 60)} min\n`);
      }
      process.stdout.write(`\n  ${C.dim}${timeline.chunks.length} recorded spans, ${timeline.chunks[timeline.chunks.length - 1]!.started_at} to ${timeline.chunks[0]!.ended_at}${C.reset}\n\n`);
      return 0;
    }
    const frame = await withKortixScope(auth, () => getProjectCaptureFrame(projectId, frameId));
    if (json) return (emitJson(frame), 0);
    process.stdout.write(`\n  ${C.dim}#${frame.frame_id}  ${frame.ts}${C.reset}  ${C.bold}${frame.app_name ?? '-'}${C.reset}  ${frame.window_title ?? ''}\n`);
    if (frame.url) process.stdout.write(`  ${C.dim}${frame.url}${C.reset}\n`);
    process.stdout.write(`\n${frame.text ?? ''}\n\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}
