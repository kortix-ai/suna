/**
 * `kortix search <query>` — search the whole of the project's Files by name
 * and text, beyond the folders a session mounts (GET /v1/projects/:id/search).
 *
 * A person sees what their folder access lets them read. Inside a session
 * (its own token) the search covers exactly the folders the session may
 * mount, also the ones that did not fit in its mount slots.
 */
import { type ProjectSearchHit, searchProject } from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix search <query> [options]

Search the workspace's Files (/Company, /Users/<name>, team and channel
folders) by file name and by text: Markdown, text, CSV, JSON, YAML, HTML
and code, the first 256 KiB of each file. Every word must match, as the
start of a word. Name matches come first.

You see only what your folder access lets you read. Inside a session the
search covers the folders the session may mount, also the ones that did
not fit in its /drives mounts. Open a hit from its /drives mount, or with
\`kortix drive cat <path>\` in your own private session. A file written in
the last ~20 s may not be found yet.

Options:
  --path <folder>    Only below this folder, e.g. /Company.
  --limit <n>        Hits per page, 1-100 (default 20).
  --cursor <c>       The next page: the cursor the previous page printed.
  --json             Emit the API payload as JSON.
  --workspace <id>   Search this workspace id (default: linked).
  --host <name>      Search on a non-default Kortix host.
  -h, --help         Show this help.

Examples:
  kortix search "launch plan"
  kortix search pricing --path /Company --limit 5
`;

export interface ParsedSearchInvocation {
  q: string;
  path?: string;
  limit?: number;
  cursor?: string;
  json: boolean;
  project?: string;
  host?: string;
}

/** argv → the request the command sends; an exit code on a usage error. */
export function parseSearchInvocation(argv: string[]): ParsedSearchInvocation | number {
  const rest = [...argv];
  let path: string | undefined;
  let limitRaw: string | undefined;
  let cursor: string | undefined;
  let project: string | undefined;
  let host: string | undefined;
  try {
    path = takeFlagValue(rest, ['--path']);
    limitRaw = takeFlagValue(rest, ['--limit', '-n']);
    cursor = takeFlagValue(rest, ['--cursor']);
    project = takeFlagValue(rest, ['--project', '--workspace']);
    host = takeFlagValue(rest, ['--host']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const json = takeFlagBool(rest, ['--json']);
  const unknown = rest.find((a) => a.startsWith('--'));
  if (unknown) return fail(`unknown option ${unknown}`);
  const q = rest.join(' ').trim();
  if (!q) return fail('Pass what to search for: kortix search <query>');
  if (q.length > 200) return fail('A query is at most 200 characters.');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) return fail('--limit is a whole number from 1 to 100.');
    limit = Number(limitRaw);
  }
  return {
    q,
    json,
    ...(path ? { path: path.startsWith('/') ? path : `/${path}` } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    ...(project ? { project } : {}),
    ...(host ? { host } : {}),
  };
}

/** One hit, two lines: the path with its access, then the passage around the words. */
export function formatSearchHit(hit: ProjectSearchHit): string {
  const kind = hit.kind === 'dir' ? `${C.dim}(folder)${C.reset} ` : '';
  const line = `${C.cyan}${hit.path}${C.reset}  ${kind}${C.dim}${hit.access}${C.reset}`;
  return hit.snippet ? `${line}\n    ${hit.snippet}` : line;
}

export async function runSearch(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const parsed = parseSearchInvocation(argv);
  if (typeof parsed === 'number') return parsed;
  const ctx = await resolveProjectContext({ projectArg: parsed.project, hostArg: parsed.host });
  if (!ctx) return 1;
  try {
    return await withKortixScope(ctx.auth, async () => {
      const result = await searchProject(ctx.projectId, {
        q: parsed.q,
        ...(parsed.path ? { path: parsed.path } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      });
      if (parsed.json) {
        emitJson(result);
        return 0;
      }
      if (result.hits.length === 0) {
        process.stdout.write(`${status.info(`No files match "${parsed.q}"${parsed.path ? ` in ${parsed.path}` : ''}.`)}\n`);
      } else {
        process.stdout.write(`${result.hits.map(formatSearchHit).join('\n')}\n`);
      }
      if (result.next_cursor) {
        process.stdout.write(`\n${C.dim}More: kortix search ${JSON.stringify(parsed.q)} --cursor ${result.next_cursor}${C.reset}\n`);
      }
      return 0;
    });
  } catch (err) {
    return surfaceApiError(err);
  }
}
