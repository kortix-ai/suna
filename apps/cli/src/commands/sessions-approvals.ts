import { getSessionAudit, resolveApproval, type RuntimePendingRecord, type SessionAuditAction } from '@kortix/sdk';
import { withCliErrors } from '../api/client.ts';
import { withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  fail,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { type ResolvedSession, loadSessionForChat } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };
type Located = NonNullable<Awaited<ReturnType<typeof locateSessionAnywhere>>>['located'];

const PENDING_HELP = help`Usage: kortix sessions pending <session-id> [options]

List the session's open interactive prompts — tool-permission asks and
questions the agent is blocked on. Answer them with
\`kortix sessions approve\` / \`kortix sessions answer\`.

Options:
  --workspace <id>  Operate on this workspace id (default: linked/default).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output ({ permissions, questions }; each
                    record has id, thread_id, call_id, payload, asked_at).
  -h, --help        Show this help.
`;

const APPROVE_HELP = help`Usage: kortix sessions approve <session-id> [<request-id>] [options]

Answer a pending tool-permission ask. With no <request-id>, acts on the
session's single pending permission (errors if there are several).

Options:
  --always           Allow this action pattern for the rest of the session.
  --reject           Deny the request.
  --message "<why>"  Note passed back to the agent with the reply.
  --workspace <id>   Operate on this workspace id (default: linked/default).
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
  --workspace <id>   Operate on this workspace id (default: linked/default).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

interface ParsedTarget {
  sessionId: string;
  requestId?: string;
  opts: CtxOpts;
}

function parseTarget(argv: string[], help: string): ParsedTarget | null {
  const rest = [...argv];
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project', '--workspace']);
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
  return {
    sessionId: positional[0],
    requestId: positional[1],
    opts: { projectArg, hostArg },
  };
}

interface QuestionInfo {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
}

/** A pending permission record's payload: what the agent wants to do. */
function permissionOf(record: RuntimePendingRecord): { permission: string; patterns: string[] } {
  const payload = (record.payload ?? {}) as { permission?: unknown; patterns?: unknown };
  return {
    permission: typeof payload.permission === 'string' ? payload.permission : '',
    patterns: Array.isArray(payload.patterns) ? payload.patterns.filter((p): p is string => typeof p === 'string') : [],
  };
}

/** A pending question record's payload: the questions the agent asked. */
function questionsOf(record: RuntimePendingRecord): QuestionInfo[] {
  const payload = (record.payload ?? {}) as { questions?: unknown };
  return Array.isArray(payload.questions) ? (payload.questions as QuestionInfo[]) : [];
}

async function pendingFor(resolved: ResolvedSession): Promise<{
  permissions: RuntimePendingRecord[];
  questions: RuntimePendingRecord[];
} | null> {
  try {
    const { permissions, questions } = await withKortixScope(resolved.auth, () => resolved.handle.pendingRequests());
    return { permissions, questions };
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

/** The one pending ask of a kind, or null once it printed why there is none to take. */
function pickSinglePending(
  items: RuntimePendingRecord[],
  kind: 'permission' | 'question',
  label: (item: RuntimePendingRecord) => string,
): RuntimePendingRecord | null {
  if (items.length === 0) {
    process.stderr.write(`${status.err(`No pending ${kind} on this session.`)}\n`);
    return null;
  }
  if (items.length > 1) {
    const listing = items.map((item) => `  ${item.id}  ${label(item)}`).join('\n');
    process.stderr.write(`${status.err(`Several ${kind}s are pending — pass a request id:`)}\n${listing}\n`);
    return null;
  }
  return items[0] ?? null;
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
      const { permission, patterns } = permissionOf(p);
      process.stdout.write(
        `  ${C.cyan}${p.id}${C.reset}  ${C.bold}${permission}${C.reset}` +
          `${patterns.length ? ` ${C.dim}${patterns.join(', ')}${C.reset}` : ''}\n` +
          `    ${C.dim}approve: kortix sessions approve ${resolved.session.session_id} ${p.id}${C.reset}\n`,
      );
    }
  }
  if (questions.length > 0) {
    process.stdout.write(`\n  ${C.white}${C.bold}Questions${C.reset}\n`);
    for (const q of questions) {
      for (const info of questionsOf(q)) {
        process.stdout.write(`  ${C.cyan}${q.id}${C.reset}  ${info.question}\n`);
        for (const o of info.options ?? []) {
          process.stdout.write(
            `    ${C.dim}- ${o.label}${o.description ? ` (${o.description})` : ''}${C.reset}\n`,
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
  if (always && reject) return fail('--always and --reject are mutually exclusive.');
  const target = parseTarget(rest, APPROVE_HELP);
  if (!target) return 2;

  const resolved = await loadSessionForChat(target.sessionId, target.opts, 'sessions approve');
  if (!resolved) return 1;

  let requestId = target.requestId;
  if (!requestId) {
    const pending = await pendingFor(resolved);
    if (!pending) return 1;
    const only = pickSinglePending(pending.permissions, 'permission', (p) => permissionOf(p).permission);
    if (!only) return 1;
    requestId = only.id;
  }

  const reply = reject ? 'reject' : always ? 'always' : 'once';
  try {
    await withKortixScope(resolved.auth, () => resolved.handle.answerPermission(requestId, reply, message));
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

  let request: RuntimePendingRecord | undefined;
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
    request = pickSinglePending(pending.questions, 'question', (q) => questionsOf(q)[0]?.header ?? '') ?? undefined;
    if (!request) return 1;
  }
  const requestId = target.requestId ?? request?.id;
  if (!requestId) {
    process.stderr.write(`${status.err('Could not resolve a question request id.')}\n`);
    return 1;
  }

  try {
    if (reject) {
      await withKortixScope(resolved.auth, () => resolved.handle.answerQuestion(requestId, null));
      process.stdout.write(`${status.ok(`Dismissed ${C.bold}${requestId}${C.reset}`)}\n`);
      return 0;
    }
    let answers: string[][];
    if (answersJson) {
      answers = JSON.parse(answersJson);
    } else {
      const infos = request ? questionsOf(request) : [];
      if (infos.length > 1) {
        return fail('This request carries several questions — pass --answers with a string[][] payload.');
      }
      // The runtime takes the displayed option labels as the answers.
      const info = infos[0];
      const mapped = options.map((o) => {
        const match = info?.options?.find((opt) => opt.label === o);
        return match?.label ?? o;
      });
      answers = [[...mapped, ...(text !== undefined ? [text] : [])]];
    }
    await withKortixScope(resolved.auth, () => resolved.handle.answerQuestion(requestId, answers));
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Answered ${C.bold}${requestId}${C.reset}`)}\n`);
  return 0;
}

// ── sessions approvals — CONNECTOR call approvals (not runtime asks) ─────────
//
// Two different gates share the word "approve" and must not be confused:
//
//   `sessions approve`   answers a runtime PERMISSION ask — the agent wants
//                        to run a tool and the runtime is blocked on a reply.
//                        Lives in the sandbox; disappears if the box restarts.
//   `sessions approvals` resolves a governed CONNECTOR call — a policy said
//                        this action needs a human before the connector runs
//                        it. Lives in Postgres and survives everything.
//
// The pending rows are the `pending_approval` entries of the session's audit
// projection; the decision goes to the project-level approvals route.

const APPROVALS_HELP = help`Usage: kortix sessions approvals <session-id> [<subcommand>] [options]

Governed connector calls this session is waiting on a human for — an action a
workspace policy said needs a decision before the connector runs it. Durable:
unlike \`sessions pending\`, these survive a sandbox restart.

Subcommands:
  ls                       List the calls awaiting a decision (default). --json.
  approve <execution-id>   Let the call run.
  deny <execution-id>      Refuse it. The agent is told and continues without it.

Options:
  --workspace <id>  Operate on this workspace id (default: linked/default).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs project.members.manage, or being the human who launched the session. An
agent may never resolve its own approval.
`;

/** `sessions approvals ls`: the calls awaiting a decision, as JSON or a table. */
async function listConnectorApprovals(located: Located, sessionId: string, json: boolean): Promise<number> {
  const { projectId, auth, session } = located;
  let actions: SessionAuditAction[];
  try {
    const audit = await withCliErrors(auth, () =>
      getSessionAudit(projectId, session.session_id, undefined, { includeEvents: false }),
    );
    actions = (audit.actions ?? []).filter((a) => a.status === 'pending_approval');
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(actions);
    return 0;
  }
  if (actions.length === 0) {
    process.stdout.write(`  ${C.dim}No connector call is waiting on a decision.${C.reset}\n`);
    return 0;
  }
  const idW = Math.max(...actions.map((a) => a.execution_id.length), 12);
  process.stdout.write('\n');
  process.stdout.write(`  ${C.dim}${pad('EXECUTION', idW)}   RISK          ACTION${C.reset}\n`);
  for (const action of actions) {
    // `action` already carries the connector prefix (`<slug>.<action>`) — the
    // same field --json emits. Never prepend `connector` again.
    process.stdout.write(
      `  ${C.cyan}${pad(action.execution_id, idW)}${C.reset}   ${pad(action.risk ?? 'unknown', 12)}  ${C.bold}${action.action}${C.reset}\n`,
    );
    const args = action.result_summary?.args_preview;
    if (args !== undefined) {
      process.stdout.write(`    ${C.dim}args ${JSON.stringify(args)}${C.reset}\n`);
    }
    process.stdout.write(
      `    ${C.dim}approve: kortix sessions approvals ${sessionId} approve ${action.execution_id}${C.reset}\n` +
        `    ${C.dim}deny: kortix sessions approvals ${sessionId} deny ${action.execution_id}${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

/** `sessions approvals approve|deny <execution-id>`: record the decision and say what happens next. */
async function decideConnectorApproval(
  located: Located,
  sub: 'approve' | 'deny',
  executionId: string,
  json: boolean,
): Promise<number> {
  try {
    await withCliErrors(located.auth, () => resolveApproval(located.projectId, executionId, sub));
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson({ execution_id: executionId, decision: sub });
    return 0;
  }
  process.stdout.write(
    `${status.ok(
      sub === 'approve'
        ? `Approved ${C.bold}${executionId}${C.reset}${C.dim} — the agent resumes and runs the call${C.reset}`
        : `Denied ${C.bold}${executionId}${C.reset}${C.dim} — the agent is told and continues without it${C.reset}`,
    )}\n`,
  );
  return 0;
}

export async function runSessionsConnectorApprovals(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(APPROVALS_HELP);
    return 0;
  }

  let opts: CtxOpts;
  let json = false;
  try {
    opts = {
      projectArg: takeFlagValue(rest, ['--project', '--workspace']),
      hostArg: takeFlagValue(rest, ['--host']),
    };
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  const sessionId = positional[0];
  const sub = positional[1] ?? 'ls';
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${APPROVALS_HELP}`);
    return 2;
  }
  if (!['ls', 'list', 'approve', 'deny'].includes(sub)) {
    process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${APPROVALS_HELP}`);
    return 2;
  }
  const executionId = positional[2];
  if ((sub === 'approve' || sub === 'deny') && !executionId) {
    return fail(`\`approvals ${sub}\` needs an execution id (see \`sessions approvals ${sessionId} ls\`).`);
  }

  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions approvals ${sessionId} ${sub} --host ${host}`,
  );
  if (!located) return 1;

  if (sub === 'approve' || sub === 'deny') return decideConnectorApproval(located.located, sub, executionId, json);
  return listConnectorApprovals(located.located, sessionId, json);
}
