import type {
  OpencodePermissionRequest,
  OpencodeQuestionRequest,
} from '../api/sandbox-proxy.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import { loadSessionForChat, type ResolvedSession } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const PENDING_HELP = help`Usage: kortix sessions pending <session-id> [options]

List the session's open interactive prompts — tool-permission asks and
questions the agent is blocked on. Answer them with
\`kortix sessions approve\` / \`kortix sessions answer\`.

Options:
  --project <id>   Operate on this project id (default: linked/default).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output ({ permissions, questions }).
  -h, --help       Show this help.
`;

const APPROVE_HELP = help`Usage: kortix sessions approve <session-id> [<request-id>] [options]

Answer a pending tool-permission ask. With no <request-id>, acts on the
session's single pending permission (errors if there are several).

Options:
  --always           Allow this action pattern for the rest of the session.
  --reject           Deny the request.
  --message "<why>"  Note passed back to the agent with the reply.
  --project <id>     Operate on this project id (default: linked/default).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

const ANSWER_HELP = help`Usage: kortix sessions answer <session-id> [<request-id>] [options]

Answer a pending question the agent asked. With no <request-id>, acts on
the session's single pending question (errors if there are several).

Options:
  --option <value>   Pick this option (label or value; repeat for
                     multi-select questions).
  --text "<answer>"  Free-text answer (for questions that accept custom
                     input; combinable with --option).
  --reject           Dismiss the question without answering.
  --answers <json>   Raw answers payload (string[][]) for requests carrying
                     several questions — overrides --option/--text.
  --project <id>     Operate on this project id (default: linked/default).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

interface ParsedTarget {
  sessionId: string;
  requestId?: string;
  opts: CtxOpts;
  rest: string[];
}

function parseTarget(argv: string[], help: string): ParsedTarget | null {
  const rest = [...argv];
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n\n${help}`);
    return null;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (!positional[0]) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${help}`);
    return null;
  }
  return { sessionId: positional[0], requestId: positional[1], opts: { projectArg, hostArg }, rest };
}

async function pendingFor(resolved: ResolvedSession): Promise<{
  permissions: OpencodePermissionRequest[];
  questions: OpencodeQuestionRequest[];
} | null> {
  try {
    const [permissions, questions] = await Promise.all([
      resolved.oc.listPermissions(),
      resolved.oc.listQuestions(),
    ]);
    return { permissions: permissions ?? [], questions: questions ?? [] };
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

export async function runSessionsPending(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(PENDING_HELP);
    return 0;
  }
  const rest = [...argv];
  const json = takeFlagBool(rest, ['--json']);
  const target = parseTarget(rest, PENDING_HELP);
  if (!target) return 2;

  const resolved = await loadSessionForChat(target.sessionId, target.opts);
  if (!resolved) return 1;
  const pending = await pendingFor(resolved);
  if (!pending) return 1;

  if (json) {
    emitJson(pending);
    return 0;
  }

  const { permissions, questions } = pending;
  if (permissions.length === 0 && questions.length === 0) {
    process.stdout.write(`${C.dim}Nothing pending — the agent isn't blocked on you.${C.reset}\n`);
    return 0;
  }
  if (permissions.length > 0) {
    process.stdout.write(`\n  ${C.white}${C.bold}Permissions${C.reset}\n`);
    for (const p of permissions) {
      process.stdout.write(
        `  ${C.cyan}${p.id}${C.reset}  ${C.bold}${p.permission}${C.reset}` +
          `${p.patterns.length ? ` ${C.dim}${p.patterns.join(', ')}${C.reset}` : ''}\n` +
          `    ${C.dim}approve: kortix sessions approve ${resolved.session.session_id} ${p.id}${C.reset}\n`,
      );
    }
  }
  if (questions.length > 0) {
    process.stdout.write(`\n  ${C.white}${C.bold}Questions${C.reset}\n`);
    for (const q of questions) {
      for (const info of q.questions) {
        process.stdout.write(`  ${C.cyan}${q.id}${C.reset}  ${info.question}\n`);
        for (const o of info.options) {
          process.stdout.write(
            `    ${C.dim}- ${o.label}${o.hint ? ` (${o.hint})` : ''}${C.reset}\n`,
          );
        }
      }
      process.stdout.write(
        `    ${C.dim}answer: kortix sessions answer ${resolved.session.session_id} ${q.id} --option "<label>"${C.reset}\n`,
      );
    }
  }
  process.stdout.write('\n');
  return 0;
}

export async function runSessionsApprove(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(APPROVE_HELP);
    return 0;
  }
  const rest = [...argv];
  const always = takeFlagBool(rest, ['--always']);
  const reject = takeFlagBool(rest, ['--reject']);
  let message: string | undefined;
  try {
    message = takeFlagValue(rest, ['--message', '-m']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n\n${APPROVE_HELP}`);
    return 2;
  }
  if (always && reject) {
    process.stderr.write(`${status.err('--always and --reject are mutually exclusive.')}\n`);
    return 2;
  }
  const target = parseTarget(rest, APPROVE_HELP);
  if (!target) return 2;

  const resolved = await loadSessionForChat(target.sessionId, target.opts);
  if (!resolved) return 1;

  let requestId = target.requestId;
  if (!requestId) {
    const pending = await pendingFor(resolved);
    if (!pending) return 1;
    if (pending.permissions.length === 0) {
      process.stderr.write(`${status.err('No pending permission on this session.')}\n`);
      return 1;
    }
    if (pending.permissions.length > 1) {
      const listing = pending.permissions.map((p) => `  ${p.id}  ${p.permission}`).join('\n');
      process.stderr.write(
        `${status.err('Several permissions are pending — pass a request id:')}\n${listing}\n`,
      );
      return 1;
    }
    requestId = pending.permissions[0].id;
  }

  const reply = reject ? 'reject' : always ? 'always' : 'once';
  try {
    await resolved.oc.replyPermission(requestId, reply, message);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `${status.ok(`${reply === 'reject' ? 'Rejected' : 'Approved'} ${C.bold}${requestId}${C.reset}`)}` +
      `${reply === 'always' ? ` ${C.dim}(and future matches this session)${C.reset}` : ''}\n`,
  );
  return 0;
}

export async function runSessionsAnswer(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(ANSWER_HELP);
    return 0;
  }
  const rest = [...argv];
  const reject = takeFlagBool(rest, ['--reject']);
  const options: string[] = [];
  let text: string | undefined;
  let answersJson: string | undefined;
  try {
    for (;;) {
      const o = takeFlagValue(rest, ['--option', '-o']);
      if (o === undefined) break;
      options.push(o);
    }
    text = takeFlagValue(rest, ['--text']);
    answersJson = takeFlagValue(rest, ['--answers']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n\n${ANSWER_HELP}`);
    return 2;
  }
  const target = parseTarget(rest, ANSWER_HELP);
  if (!target) return 2;
  if (!reject && !answersJson && options.length === 0 && text === undefined) {
    process.stderr.write(
      `${status.err('Pass an answer: --option/--text (or --reject).')}\n\n${ANSWER_HELP}`,
    );
    return 2;
  }

  const resolved = await loadSessionForChat(target.sessionId, target.opts);
  if (!resolved) return 1;

  let request: OpencodeQuestionRequest | undefined;
  if (target.requestId) {
    const pending = await pendingFor(resolved);
    if (!pending) return 1;
    request = pending.questions.find((q) => q.id === target.requestId);
    if (!request && !reject) {
      process.stderr.write(`${status.err(`No pending question ${target.requestId}.`)}\n`);
      return 1;
    }
  } else {
    const pending = await pendingFor(resolved);
    if (!pending) return 1;
    if (pending.questions.length === 0) {
      process.stderr.write(`${status.err('No pending question on this session.')}\n`);
      return 1;
    }
    if (pending.questions.length > 1) {
      const listing = pending.questions
        .map((q) => `  ${q.id}  ${q.questions[0]?.header ?? ''}`)
        .join('\n');
      process.stderr.write(
        `${status.err('Several questions are pending — pass a request id:')}\n${listing}\n`,
      );
      return 1;
    }
    request = pending.questions[0];
  }
  const requestId = target.requestId ?? request?.id;
  if (!requestId) {
    process.stderr.write(`${status.err('Could not resolve a question request id.')}\n`);
    return 1;
  }

  try {
    if (reject) {
      await resolved.oc.rejectQuestion(requestId);
      process.stdout.write(`${status.ok(`Dismissed ${C.bold}${requestId}${C.reset}`)}\n`);
      return 0;
    }
    let answers: string[][];
    if (answersJson) {
      answers = JSON.parse(answersJson);
    } else {
      if (request && request.questions.length > 1) {
        process.stderr.write(
          `${status.err('This request carries several questions — pass --answers with a string[][] payload.')}\n`,
        );
        return 2;
      }
      // Map option labels to canonical values where the question defines them.
      const info = request?.questions[0];
      const mapped = options.map((o) => {
        const match = info?.options.find(
          (opt) => opt.label === o || opt.value === o,
        );
        return match?.value ?? match?.label ?? o;
      });
      answers = [[...mapped, ...(text !== undefined ? [text] : [])]];
    }
    await resolved.oc.replyQuestion(requestId, answers);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Answered ${C.bold}${requestId}${C.reset}`)}\n`);
  return 0;
}
