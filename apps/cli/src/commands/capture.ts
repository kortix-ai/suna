/**
 * `kortix capture` — search the Kortix Capture timeline of the person you act for.
 *
 * Kortix Capture records a person's own screen (app, window title, URL,
 * on-screen text), their input actions and, when the account's policy allows,
 * audio. Capture belongs to the Kortix account, not to a project.
 * Inside a session sandbox the token acts for the person the session runs for
 * (a private session); logged in as a user, it is you. Never another member.
 * The data is personal: read what the task needs, no more.
 */
import { getMyCaptureFrame, getMyCaptureTimeline, searchMyCapture, type CaptureSearchKind } from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectAuth, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, pad } from '../style.ts';

const HELP = help`Usage: kortix capture <subcommand> [options]

Search the timeline Kortix Capture recorded for the person you act for: what
was on screen (app, window title, URL, on-screen text), input actions, and
audio transcripts. Inside a session it reads the timeline of the person the
session runs for, in the account your token belongs to. It never reads another
member's timeline. Capture is switched on per Kortix account (off by default;
403 capture_disabled while off). Without a person (a trigger run, a shared
session) the command fails with 403 capture_no_human.

Subcommands:
  search <query>    Full-text search, newest first.
  timeline          One day: what ran when (app, window) and the activity ranges.
  frame <id>        One screen frame with its full on-screen text.

Options:
  --kinds <list>    search: screen,actions,audio (default: all three).
  --app <name>      search: only this app (exact name, any case).
  --from <iso>      search, timeline: start (ISO 8601).
  --to <iso>        search, timeline: end (exclusive).
  --day <date>      timeline: one UTC day, YYYY-MM-DD (default: today).
  --limit <n>       search: results, 1 to 100 (default 20).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Examples:
  kortix capture search "invoice 1042" --kinds screen,audio
  kortix capture timeline --day 2026-10-03
  kortix capture frame 01a10306-0000-7000-8000-000000000000 --json
`;

const KINDS: CaptureSearchKind[] = ['screen', 'actions', 'audio'];
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

export async function runCapture(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  let f: Record<string, string | undefined>;
  let json = false;
  try {
    f = {
      kinds: takeFlagValue(rest, ['--kinds']),
      app: takeFlagValue(rest, ['--app']),
      from: takeFlagValue(rest, ['--from']),
      to: takeFlagValue(rest, ['--to']),
      day: takeFlagValue(rest, ['--day']),
      limit: takeFlagValue(rest, ['--limit']),
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
  const kinds = f.kinds?.split(',').map((k) => k.trim()) as CaptureSearchKind[] | undefined;
  if (kinds?.some((k) => !KINDS.includes(k))) return fail('--kinds takes screen, actions and audio.');
  const query = sub === 'search' ? rest.join(' ').trim() : '';
  if (sub === 'search' && !query) return missing('a search query, e.g. kortix capture search "invoice"');
  const frameId = sub === 'frame' ? rest[0] : undefined;
  if (sub === 'frame' && !frameId) return missing('a frame id: kortix capture frame <id> (from `capture search`)');
  if (f.day && !/^\d{4}-\d{2}-\d{2}$/.test(f.day)) return fail('--day must be YYYY-MM-DD.');

  // The account is the token's own: inside a session, the session's; logged in, yours.
  const { auth } = resolveProjectAuth({ hostArg: f.host });
  if (!auth?.token) return fail('Not logged in. Run `kortix login`.');
  try {
    if (sub === 'search') {
      const result = await withKortixScope(auth, () =>
        searchMyCapture({ q: query, kinds, app: f.app, from: f.from, to: f.to, limit }),
      );
      if (json) return (emitJson(result), 0);
      if (result.hits.length === 0) {
        process.stdout.write(`  ${C.dim}No matches.${C.reset}\n`);
        return 0;
      }
      for (const hit of result.hits) {
        process.stdout.write(
          `\n  ${C.dim}${hit.kind.padEnd(7)} ${hit.ts}  ${hit.id}${C.reset}\n  ${C.bold}${hit.app ?? '-'}${C.reset}  ${hit.title ?? ''}\n`,
        );
        if (hit.url) process.stdout.write(`    ${C.dim}${hit.url}${C.reset}\n`);
        if (hit.snippet.trim()) process.stdout.write(`    ${hit.snippet}\n`);
      }
      process.stdout.write('\n');
      return 0;
    }
    if (sub === 'timeline') {
      const timeline = await withKortixScope(auth, () =>
        getMyCaptureTimeline(f.from || f.to ? { from: f.from, to: f.to } : { day: f.day }),
      );
      if (json) return (emitJson(timeline), 0);
      if (timeline.runs.length === 0 && timeline.ranges.length === 0) {
        process.stdout.write(`  ${C.dim}Nothing recorded from ${timeline.from} to ${timeline.to}.${C.reset}\n`);
        return 0;
      }
      process.stdout.write(`\n  ${C.dim}${pad('START', 22)}${pad('TIME', 9)}APP — WINDOW${C.reset}\n`);
      for (const run of timeline.runs) {
        const span = Date.parse(run.end_at) - Date.parse(run.start_at);
        process.stdout.write(`  ${pad(run.start_at.slice(0, 19).replace('T', ' '), 22)}${pad(minutes(span), 9)}${run.app ?? '-'} — ${run.title ?? ''}\n`);
      }
      if (timeline.ranges.length) {
        process.stdout.write(`\n  ${C.dim}RANGES${C.reset}\n`);
        for (const range of timeline.ranges) {
          process.stdout.write(`  ${range.start_at.slice(11, 16)}–${range.end_at.slice(11, 16)}  ${range.title ?? range.source}  ${C.dim}${range.status}${C.reset}\n`);
        }
      }
      process.stdout.write('\n');
      return 0;
    }
    const detail = await withKortixScope(auth, () => getMyCaptureFrame(frameId!));
    if (json) return (emitJson(detail), 0);
    const frame = detail.frame;
    process.stdout.write(`\n  ${C.dim}${frame.ts}  ${frame.frame_id}${C.reset}  ${C.bold}${frame.app ?? '-'}${C.reset}  ${frame.title ?? ''}\n`);
    if (frame.url) process.stdout.write(`  ${C.dim}${frame.url}${C.reset}\n`);
    process.stdout.write(`\n${frame.ocr_text ?? ''}\n\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}
