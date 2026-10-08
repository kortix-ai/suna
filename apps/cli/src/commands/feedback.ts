/**
 * `kortix feedback "<message>"` — file product feedback from the terminal.
 *
 * An agent in a session (KORTIX_SESSION_ID set) or a person in a shell files
 * a bug report, an idea or a friction note without leaving the flow. The
 * message goes to POST /v1/feedback; the receipt is the stored id.
 */
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectAuth,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { clientFromAuth } from '../api/client.ts';
import { C, help, status } from '../style.ts';

export const FEEDBACK_KINDS = ['bug', 'idea', 'friction'] as const;
export const FEEDBACK_SOURCES = ['cli', 'agent', 'web'] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export interface ParsedFeedbackInvocation {
  message: string;
  kind: FeedbackKind;
  source?: FeedbackSource;
  context: Record<string, string>;
  json: boolean;
  host?: string;
}

const HELP = help`Usage: kortix feedback "<message>" [options]

File product feedback — a bug, an idea or a friction note — straight from
the terminal or an agent session. Inside a Kortix session the report is
filed as an agent report and tagged with the session id.

Options:
  --kind <kind>      bug | idea | friction (default: idea).
  --source <source>  cli | agent | web. Default: agent inside a Kortix
                     session ($KORTIX_SESSION_ID set), else cli.
  --context <json>   Extra context ids as JSON, e.g. '{"project_id":"…"}'.
                     Inside a session the session and project ids are added
                     automatically.
  --host <name>      File against a non-default Kortix host.
  --json             Machine-readable output (the raw receipt).
  -h, --help         Show this help.

Examples:
  kortix feedback "the CLI hangs on projects ls when offline" --kind bug
  kortix feedback "a sessions --watch flag would save me a loop" --kind idea
  kortix feedback "the doctor output is hard to scan" --kind friction
`;

/** argv → the request the command sends. Split from the I/O so the parse is
 *  unit-testable without a live host. */
export function parseFeedbackInvocation(
  argv: string[],
  env: { KORTIX_SESSION_ID?: string; KORTIX_PROJECT_ID?: string },
): ParsedFeedbackInvocation | number {
  const rest = [...argv];
  let flags: Record<string, string | undefined>;
  try {
    flags = {
      kind: takeFlagValue(rest, ['--kind']),
      source: takeFlagValue(rest, ['--source']),
      context: takeFlagValue(rest, ['--context']),
      host: takeFlagValue(rest, ['--host']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }
  const json = takeFlagBool(rest, ['--json']);

  const kind = (flags.kind ?? 'idea') as FeedbackKind;
  if (!FEEDBACK_KINDS.includes(kind)) {
    return fail(`Unknown kind "${flags.kind}". Use one of: ${FEEDBACK_KINDS.join(', ')}.`);
  }
  const source = flags.source as FeedbackSource | undefined;
  if (flags.source && !FEEDBACK_SOURCES.includes(source!)) {
    return fail(`Unknown source "${flags.source}". Use one of: ${FEEDBACK_SOURCES.join(', ')}.`);
  }

  const message = rest.join(' ').trim();
  if (!message) {
    return missing('the feedback message, e.g. kortix feedback "the CLI hangs on projects ls"');
  }

  let context: Record<string, string> = {};
  if (flags.context) {
    try {
      const parsed: unknown = JSON.parse(flags.context);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail('--context expects a flat JSON object of id => value.');
      }
      context = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    } catch {
      return fail('--context expects a flat JSON object of id => value.');
    }
  }
  const sessionId = env.KORTIX_SESSION_ID?.trim();
  if (sessionId) context.session_id = sessionId;
  const projectId = env.KORTIX_PROJECT_ID?.trim();
  if (projectId) context.project_id = projectId;

  return { message, kind, source, context, json, host: flags.host };
}

async function submit(inv: ParsedFeedbackInvocation): Promise<number> {
  // Inside a session the report is an agent report; the CLI outside is cli.
  const source = inv.source ?? (inv.context.session_id ? 'agent' : 'cli');
  // resolveProjectAuth (not the account resolver) so the injected sandbox
  // token — KORTIX_TOKEN, the credential an agent session actually has —
  // works without a stored login. Feedback is identity-scoped; the server
  // records the account from the credential itself.
  const { auth, hostName } = resolveProjectAuth({ hostArg: inv.host });
  if (!auth?.token) {
    if (hostName) {
      process.stderr.write(
        `${status.err(`Host "${hostName}" is not logged in.`)} Run ` +
          `${C.cyan}kortix login --host ${hostName}${C.reset}.\n`,
      );
    } else {
      process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    }
    return 1;
  }
  try {
    const receipt = await clientFromAuth(auth).post<{
      id: string;
      source: string;
      kind: string;
      created_at: string;
    }>('/feedback', { source, kind: inv.kind, message: inv.message, context: inv.context });
    if (inv.json) {
      emitJson(receipt);
      return 0;
    }
    process.stdout.write(`\n  ${status.ok(`Feedback filed · ${C.bold}${receipt.id}${C.reset}`)}\n`);
    process.stdout.write(`  ${C.dim}kind    ${C.reset}${receipt.kind}\n`);
    process.stdout.write(`  ${C.dim}source  ${C.reset}${receipt.source}\n`);
    process.stdout.write(`  ${C.dim}at      ${C.reset}${receipt.created_at.slice(0, 16).replace('T', ' ')} UTC\n`);
    process.stdout.write('\n');
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

export async function runFeedback(argv: string[]): Promise<number> {
  const help = splitHelp(argv, HELP);
  if (help !== null) return help;
  const parsed = parseFeedbackInvocation(
    argv,
    process.env as { KORTIX_SESSION_ID?: string; KORTIX_PROJECT_ID?: string },
  );
  if (typeof parsed === 'number') return parsed;
  return submit(parsed);
}
