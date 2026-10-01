/**
 * `kortix send` — message another session's agent, or ask people.
 *
 * One verb, two target kinds:
 *   - a session id  → queue a prompt into that session (`queueSessionPrompt`)
 *   - email(s)      → open a NEW conversation with those project members
 *                     (`POST /projects/:id/sessions` with `participants`)
 * Inside a sandbox the server derives the sender from the credential.
 */
import { ApiError } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  emitJson,
  locateSessionAnywhere,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { featureHidden } from '../features.ts';
import { C, help, status } from '../style.ts';
import { sessionWebUrl } from '../web-url.ts';
import { queueSessionPrompt } from './sessions-queue.ts';

const HELP = help`Usage: kortix send <target>... "<text>" [options]
       kortix send <target>... -p "<text>" [options]

Send a message. The target decides what happens:
  <session-id>     Message that session's agent. Queued; wakes a stopped session.
  <email>          Ask one project member. Opens a new conversation that shows
                   up under "Asked you" for them.
  <email> <email>  Ask several members in one group conversation.

The people and the agent in a new conversation cannot read your session, so the
text must carry all the context. Their answer comes back to you later as a
\`[MESSAGE from session …]\` prompt: end your turn or do other work, do not poll.
Inside a session the sender is that session. Mixing a session id with emails is
an error. Emails must belong to project members (\`kortix access ls\`).

Emailing people needs the project feature flag human_messaging:
  kortix projects features enable human_messaging

Options:
  -p, --prompt <text>  The message text (alternative to the last argument).
  --project <id>       Project for email targets (default: linked / current).
  --name <title>       Name the new conversation (default: first line of text).
  --host <name>        Operate against a non-default Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Examples:
  kortix send 3f2a9c1e-7b04-4d58-9a21-0c5e8d6b1f77 "Status? Reply with kortix send."
  kortix send avery@example.com "Which region should the database live in: us-east or eu-west? Context: …"
  kortix send avery@example.com sam@example.com "Two options for the launch date, which one? …" --name "Launch date"
`;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendArgs {
  kind: 'session' | 'people';
  targets: string[];
  text: string;
  project?: string;
  host?: string;
  name?: string;
  json: boolean;
}

/** Parse argv. Returns the parsed args or a usage error message (exit 2). */
export function parseSendArgs(argv: string[]): SendArgs | { error: string } {
  const rest = [...argv];
  let project: string | undefined;
  let host: string | undefined;
  let name: string | undefined;
  let prompt: string | undefined;
  let json: boolean;
  try {
    project = takeFlagValue(rest, ['--project']);
    host = takeFlagValue(rest, ['--host']);
    name = takeFlagValue(rest, ['--name']);
    prompt = takeFlagValue(rest, ['--prompt', '-p']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const flag = rest.find((a) => a.startsWith('-'));
  if (flag) return { error: `Unknown option ${flag}.` };

  const isTarget = (a: string) => SESSION_ID.test(a) || EMAIL.test(a);
  let targets: string[];
  let text = prompt;
  if (prompt !== undefined) {
    targets = rest;
  } else {
    // Targets are the leading target-shaped words; the text is everything after.
    let n = 0;
    while (n < rest.length && isTarget(rest[n])) n += 1;
    targets = rest.slice(0, n);
    text = rest.slice(n).join(' ');
  }
  text = text?.trim();
  const bad = targets.find((t) => !isTarget(t));
  if (bad) return { error: `"${bad}" is not a session id (UUID) or an email address.` };
  if (targets.length === 0) return { error: 'Pass a target: a session id or one or more emails.' };
  const sessions = targets.filter((t) => SESSION_ID.test(t));
  if (sessions.length > 0 && sessions.length < targets.length) {
    return { error: 'Do not mix a session id with emails. Send to one or the other.' };
  }
  if (sessions.length > 1) return { error: 'Pass one session id per `kortix send`.' };
  if (!text) return { error: 'Pass the message text, e.g. kortix send <target> "…".' };
  return {
    kind: sessions.length ? 'session' : 'people',
    targets,
    text,
    project,
    host,
    name,
    json,
  };
}

export async function runSend(argv: string[]): Promise<number> {
  // Inside a sandbox whose project has the flag off: one line, no usage dump.
  if (featureHidden('human_messaging')) {
    process.stderr.write(
      `${status.err('Human Messaging is not enabled for this project. Enable it in Settings → Feature flags.')}\n`,
    );
    return 1;
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = parseSendArgs(argv);
  if ('error' in args) {
    process.stderr.write(`${status.err(args.error)}\n\n${HELP}`);
    return 2;
  }
  return args.kind === 'session' ? sendToSession(args) : sendToPeople(args);
}

async function sendToSession(args: SendArgs): Promise<number> {
  const id = args.targets[0]!;
  // Post into the current project first, without reading the target: a
  // session may message its parent, or reply to a session that messaged it,
  // without being allowed to read it. The server decides. Only a 404 falls
  // through to the cross-project / cross-host lookup.
  const ctx = await resolveProjectContext({ projectArg: args.project, hostArg: args.host, quietWhenUnresolved: true });
  if (ctx) {
    try {
      const result = await queueSessionPrompt(ctx.client, ctx.projectId, { session_id: id } as ProjectSession, args.text);
      return reportSent(args, id, result.message_id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return surfaceApiError(err);
    }
  }
  const located = await locateSessionAnywhere(
    id,
    { projectArg: args.project, hostArg: args.host },
    (host) => `kortix send ${id} "…" --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  try {
    const result = await queueSessionPrompt(client, projectId, session, args.text);
    return reportSent(args, session.session_id, result.message_id);
  } catch (err) {
    return surfaceApiError(err);
  }
}

function reportSent(args: SendArgs, sessionId: string, messageId: string): number {
  if (args.json) {
    emitJson({ kind: 'session', session_id: sessionId, message_id: messageId, queued: true });
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Sent to session ${C.bold}${sessionId}${C.reset} ${C.dim}(queued)${C.reset}`)}\n`,
  );
  return 0;
}

async function sendToPeople(args: SendArgs): Promise<number> {
  const ctx = await resolveProjectContext({ projectArg: args.project, hostArg: args.host });
  if (!ctx) return 1;
  const { client, projectId, auth } = ctx;
  try {
    const created = await client.post<ProjectSession>(`/projects/${projectId}/sessions`, {
      participants: args.targets,
      initial_prompt: args.text,
      ...(args.name ? { name: args.name } : {}),
    });
    const url = sessionWebUrl(auth.api_base, projectId, created.session_id);
    if (args.json) {
      emitJson({
        kind: 'people',
        session_id: created.session_id,
        project_id: projectId,
        to: args.targets,
        url,
      });
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Asked ${args.targets.join(', ')} ${C.dim}— conversation ${url}${C.reset}`)}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ApiError && (err.body as { code?: string } | null)?.code === 'feature_disabled') {
      process.stderr.write(
        `${status.err(`${err.message} Run \`kortix projects features enable human_messaging\` to turn it on.`)}\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }
}
