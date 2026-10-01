import { takeFlags } from '../command-argv.ts';
import {
  emitJson,
  fail,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import type { ProjectSession } from '../api/types.ts';
import { C, help, status } from '../style.ts';

const USAGE = help`Usage: kortix sessions update [<session-id>] [options]

Change a session's labels and metadata. Without a session id it updates
$KORTIX_SESSION_ID — the session the agent runs in.

Options:
  --label <label>        Add a label (repeatable; free-form, 1..64 characters,
                         at most 20 per session).
  --unlabel <label>      Remove a label (repeatable).
  --clear-labels         Remove every label first.
  --meta <key>=<value>   Set a metadata key to a string (repeatable).
  --unmeta <key>         Remove a metadata key (repeatable).
  --project <id>         Project of the session (default: linked).
  --host <name>          Host of the session.
  --json                 Print the updated session.
  -h, --help             Show this help.

Examples:
  kortix sessions update 3f2a91c0 --label bug --meta ticket=T-142
  kortix sessions update --label needs-review        # inside a session
  kortix sessions ls --label bug                     # list by label
`;

/** `--meta key=value` → [key, value]. The value may itself contain `=`. */
export function parseMetaPair(pair: string): [string, string] {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new Error(`--meta expects key=value, got "${pair}"`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

export async function runSessionsUpdate(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, USAGE, (rest) => {
    const set: Record<string, string> = {};
    const parsed = {
      json: takeFlagBool(rest, ['--json']),
      clear: takeFlagBool(rest, ['--clear-labels']),
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
      add: takeFlagValues(rest, ['--label']),
      remove: takeFlagValues(rest, ['--unlabel']),
      unset: takeFlagValues(rest, ['--unmeta']),
      set,
      sessionId: undefined as string | undefined,
    };
    for (const pair of takeFlagValues(rest, ['--meta'])) {
      const [key, value] = parseMetaPair(pair);
      set[key] = value;
    }
    if (rest[0] && !rest[0].startsWith('-')) parsed.sessionId = rest.shift();
    return parsed;
  });
  if (typeof flags === 'number') return flags;
  const { add, remove, set, unset, clear, json } = flags;

  const sessionId = flags.sessionId ?? process.env.KORTIX_SESSION_ID;
  if (!sessionId) return fail('Pass a session id. Inside a session it defaults to $KORTIX_SESSION_ID.');
  const labelsChange = clear || add.length > 0 || remove.length > 0;
  if (!labelsChange && Object.keys(set).length === 0 && unset.length === 0) {
    return fail('Nothing to update. Pass --label, --unlabel, --clear-labels, --meta key=value or --unmeta key.');
  }

  const located = await locateSessionAnywhere(
    sessionId,
    { projectArg: flags.projectArg, hostArg: flags.hostArg },
    (host) => `kortix sessions update ${sessionId} … --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  const body: { labels?: string[]; metadata?: Record<string, string | null> } = {};
  if (labelsChange) {
    // ponytail: read-modify-write of the label list; a concurrent writer's
    // change between the read and this PATCH is lost. Add server-side
    // add/remove if two writers ever label one session at the same moment.
    const kept = (clear ? [] : (session.labels ?? [])).filter((label) => !remove.includes(label));
    body.labels = [...new Set([...kept, ...add])];
  }
  if (Object.keys(set).length > 0 || unset.length > 0) {
    body.metadata = { ...set, ...Object.fromEntries(unset.map((key) => [key, null])) };
  }

  let updated: ProjectSession;
  try {
    updated = await client.patch<ProjectSession>(
      `/projects/${projectId}/sessions/${session.session_id}`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(updated);
    return 0;
  }
  process.stdout.write(`${status.ok(`Updated ${C.bold}${updated.name ?? updated.session_id}${C.reset}`)}\n`);
  const labels = updated.labels ?? [];
  process.stdout.write(`  ${C.dim}labels   ${C.reset}${labels.length ? labels.join(', ') : '(none)'}\n`);
  if (body.metadata) {
    const changes = Object.entries(body.metadata).map(([key, value]) =>
      value === null ? `-${key}` : `${key}=${value}`,
    );
    process.stdout.write(`  ${C.dim}metadata ${C.reset}${changes.join(' ')}\n`);
  }
  return 0;
}
