import {
  projectAcpPendingPrompts,
  type AcpPendingPermission,
  type AcpPendingQuestion,
  type AcpStoredEnvelope,
} from '@kortix/sdk/acp/transcript';
import type { AcpJsonRpcId } from '@kortix/sdk/acp';
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
  --answers <json>   Raw answer JSON. string[][] maps to legacy question
                     answers; an object is sent as ACP elicitation content.
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
  permissions: AcpPendingPermission[];
  questions: AcpPendingQuestion[];
} | null> {
  try {
    const transcript = await resolved.ctx.client.get<{
      runtime_id: string;
      envelopes: AcpStoredEnvelope[];
    }>(`/projects/${resolved.ctx.projectId}/sessions/${resolved.session.session_id}/acp/transcript`);
    return projectAcpPendingPrompts(transcript.envelopes ?? []);
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

async function respondAcp(
  resolved: ResolvedSession,
  id: AcpJsonRpcId,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): Promise<void> {
  await resolved.ctx.client.post(
    `/projects/${resolved.ctx.projectId}/sessions/${resolved.session.session_id}/acp`,
    {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null }),
    },
  );
}

function optionField(option: AcpPendingPermission['options'][number]): string {
  return [
    option.kind,
    option.optionId,
    option.id,
    option.value,
    option.label,
  ].filter(Boolean).join(' ').toLowerCase();
}

function selectPermissionOption(
  request: AcpPendingPermission | undefined,
  reply: 'once' | 'always' | 'reject',
): string | null {
  const options = request?.options ?? [];
  const choose = (match: (text: string) => boolean) => {
    const option = options.find((candidate) => match(optionField(candidate)));
    return option?.optionId ?? option?.id ?? option?.value ?? null;
  };
  if (reply === 'once') {
    return choose((text) => text.includes('allow_once') || text.includes('allow-once') || text.includes('once'))
      ?? choose((text) => text.includes('allow') || text.includes('approve'))
      ?? options[0]?.optionId
      ?? options[0]?.id
      ?? options[0]?.value
      ?? 'allow_once';
  }
  if (reply === 'always') {
    return choose((text) => text.includes('allow_always') || text.includes('allow-always') || text.includes('always'))
      ?? 'allow_always';
  }
  return choose((text) => text.includes('reject') || text.includes('deny') || text.includes('cancel'));
}

function permissionResult(
  request: AcpPendingPermission | undefined,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): unknown {
  const optionId = selectPermissionOption(request, reply);
  const base = optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
  return message ? { ...base, _meta: { kortixMessage: message } } : base;
}

function isElicitation(request: AcpPendingQuestion | undefined): boolean {
  return typeof request?.method === 'string' && request.method.includes('elicitation');
}

function answerContentFromMatrix(
  request: AcpPendingQuestion | undefined,
  answers: string[][],
): Record<string, unknown> {
  const questions = request?.questions ?? [];
  const content: Record<string, unknown> = {};
  questions.forEach((question, index) => {
    const values = answers[index] ?? [];
    const value = values.length > 1 ? values : (values[0] ?? '');
    content[question.key ?? `answer_${index + 1}`] = value;
  });
  if (Object.keys(content).length === 0) {
    const values = answers[0] ?? [];
    content.answer = values.length > 1 ? values : (values[0] ?? '');
  }
  return content;
}

function questionResult(
  request: AcpPendingQuestion | undefined,
  answers: string[][],
  rawContent?: unknown,
): unknown {
  if (isElicitation(request)) {
    return {
      action: 'accept',
      content: rawContent && !Array.isArray(rawContent)
        ? rawContent
        : answerContentFromMatrix(request, answers),
    };
  }
  return { answers: rawContent ?? answers };
}

function questionRejectResult(request: AcpPendingQuestion | undefined): unknown {
  return isElicitation(request) ? { action: 'decline' } : {};
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

  const resolved = await loadSessionForChat(target.sessionId, target.opts, 'sessions pending');
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

  const resolved = await loadSessionForChat(target.sessionId, target.opts, 'sessions approve');
  if (!resolved) return 1;

  let requestId: AcpJsonRpcId | undefined = target.requestId;
  let request: AcpPendingPermission | undefined;
  const pending = await pendingFor(resolved);
  if (!pending) return 1;
  if (!requestId) {
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
    request = pending.permissions[0];
  } else {
    request = pending.permissions.find((p) => String(p.id) === requestId);
  }

  const reply = reject ? 'reject' : always ? 'always' : 'once';
  try {
    await respondAcp(resolved, requestId, permissionResult(request, reply, message));
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

  const resolved = await loadSessionForChat(target.sessionId, target.opts, 'sessions answer');
  if (!resolved) return 1;

  let request: AcpPendingQuestion | undefined;
  if (target.requestId) {
    const pending = await pendingFor(resolved);
    if (!pending) return 1;
    request = pending.questions.find((q) => String(q.id) === target.requestId);
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
      await respondAcp(resolved, requestId, questionRejectResult(request));
      process.stdout.write(`${status.ok(`Dismissed ${C.bold}${requestId}${C.reset}`)}\n`);
      return 0;
    }
    let answers: string[][];
    let rawContent: unknown;
    if (answersJson) {
      const parsed = JSON.parse(answersJson);
      if (Array.isArray(parsed)) answers = parsed as string[][];
      else {
        answers = [];
        rawContent = parsed;
      }
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
        const wanted = o.toLowerCase();
        const match = info?.options.find(
          (opt) =>
            opt.label === o ||
            opt.value === o ||
            opt.optionId === o ||
            opt.id === o ||
            opt.label.toLowerCase() === wanted ||
            opt.value?.toLowerCase() === wanted ||
            opt.optionId?.toLowerCase() === wanted ||
            opt.id?.toLowerCase() === wanted,
        );
        return match?.value ?? match?.optionId ?? match?.id ?? match?.label ?? o;
      });
      answers = [[...mapped, ...(text !== undefined ? [text] : [])]];
    }
    await respondAcp(
      resolved,
      requestId,
      questionResult(request, answers, rawContent),
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Answered ${C.bold}${requestId}${C.reset}`)}\n`);
  return 0;
}
