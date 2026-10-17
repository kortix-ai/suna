/**
 * Pin a session in your own list, or archive it out of the list.
 * Per person: only the caller's list changes. Archiving unpins; pinning
 * unarchives. Neither moves the session's `updated_at`.
 */

import { takeFlags } from '../command-argv.ts';
import {
  emitJson,
  fail,
  locateSessionAnywhere,
  shortId,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import type { ProjectSession } from '../api/types.ts';
import { C, help, status } from '../style.ts';

export type ListStateVerb = 'pin' | 'unpin' | 'archive' | 'unarchive';

const VERBS: Record<ListStateVerb, { route: 'pin' | 'archive'; body: Record<string, boolean>; done: string }> = {
  pin: { route: 'pin', body: { pinned: true }, done: 'Pinned' },
  unpin: { route: 'pin', body: { pinned: false }, done: 'Unpinned' },
  archive: { route: 'archive', body: { archived: true }, done: 'Archived' },
  unarchive: { route: 'archive', body: { archived: false }, done: 'Unarchived' },
};

const USAGE = help`Usage: kortix sessions pin|unpin|archive|unarchive <session-id>... [options]

Pin a session in your own list, or archive it out of your list. Only your
list changes: other people see the session as before. Archiving a pinned
session unpins it. Pinning an archived session unarchives it. Neither stops
the session or changes its updated_at.

\`kortix sessions ls\` marks a pinned session (pinned) and leaves out the
sessions you archived. \`ls --pinned\` lists only your pinned sessions, and
\`ls --archived\` only your archived ones.

Only a person can pin or archive. An agent's session token, an API key and a
service account get 403.

Options:
  --project <id>   Project of the sessions (default: linked).
  --host <name>    Host of the sessions.
  --json           Print one result per session: session_id, project_id,
                   ok, pinned_at, archived_at (or error).
  -h, --help       Show this help.

Examples:
  kortix sessions pin 3f2a91c0
  kortix sessions archive 3f2a91c0 7b1c0d22
  kortix sessions ls --archived
  kortix sessions unarchive 3f2a91c0
`;

/**
 * Pin, unpin, archive or unarchive one or more sessions. Each id is attempted
 * on its own, as `sessions rm` does: one refusal does not stop the rest, and
 * the failures are summarized at the end.
 */
export async function runSessionsListState(verb: ListStateVerb, argv: string[]): Promise<number> {
  const flags = takeFlags(argv, USAGE, (rest) => {
    const parsed = {
      json: takeFlagBool(rest, ['--json']),
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
      ids: rest.filter((arg) => !arg.startsWith('-')),
    };
    // Leave only the unknown options, so takeFlags rejects them.
    rest.splice(0, rest.length, ...rest.filter((arg) => arg.startsWith('-')));
    return parsed;
  });
  if (typeof flags === 'number') return flags;
  if (flags.ids.length === 0) return fail('Pass a session id.');

  const { route, body, done } = VERBS[verb];
  const opts = { projectArg: flags.projectArg, hostArg: flags.hostArg };
  const results: Array<{
    session_id: string;
    project_id?: string;
    ok: boolean;
    pinned_at?: string | null;
    archived_at?: string | null;
    error?: string;
  }> = [];
  for (const sessionId of flags.ids) {
    const located = await locateSessionAnywhere(
      sessionId,
      opts,
      (host) => `kortix sessions ${verb} ${sessionId} --host ${host}`,
    );
    if (!located) {
      results.push({ session_id: sessionId, ok: false, error: 'not found' });
      continue;
    }
    const { client, projectId, session } = located.located;
    try {
      const state = await client.put<Pick<ProjectSession, 'pinned_at' | 'archived_at'>>(
        `/projects/${projectId}/sessions/${session.session_id}/${route}`,
        body,
      );
      results.push({
        session_id: session.session_id,
        project_id: projectId,
        ok: true,
        pinned_at: state.pinned_at ?? null,
        archived_at: state.archived_at ?? null,
      });
      if (!flags.json) {
        process.stdout.write(
          `${status.ok(`${done} ${C.bold}${session.name ?? shortId(session.session_id)}${C.reset}`)}\n`,
        );
      }
    } catch (err) {
      surfaceApiError(err);
      results.push({ session_id: session.session_id, ok: false, error: (err as Error).message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (flags.json) {
    emitJson(results);
    return failed.length > 0 ? 1 : 0;
  }
  if (failed.length > 0) {
    process.stderr.write(
      `${status.err(`${failed.length} of ${results.length} session${results.length === 1 ? '' : 's'} could not be ${done.toLowerCase()}: ${failed.map((f) => shortId(f.session_id)).join(', ')}`)}\n`,
    );
    return 1;
  }
  return 0;
}
