/**
 * Messages between sessions: `kortix sessions message`, `sessions reachable`
 * and `sessions inbound`. The wire contract is
 * `@kortix/api-contract/multi-agent` (routes, bodies, limits); the types below
 * are the fields this file reads from it. The server resolves `to`, checks
 * that the caller may prompt the receiver, applies the receiver's inbound
 * mode and the limits, and delivers the text (`peerMessagePromptText` in
 * `@kortix/shared`). This file is argument parsing and output.
 *
 * A message always has a sender session: the session this CLI runs in
 * ($KORTIX_SESSION_ID), or `--from <session>` outside a session.
 */
import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  expandSessionIdPrefix,
  fail,
  missing,
  resolveProjectContext,
  SESSION_UUID_RE,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { machineErrors, writeMachineError } from '../token-denial.ts';
import { C, help, pad, status } from '../style.ts';

/** Same values as `PEER_MESSAGE_MAX_CHARS` / `PEER_MESSAGE_SUMMARY_MAX_CHARS` in the contract. */
export const PEER_MESSAGE_MAX_CHARS = 16_000;
export const PEER_MESSAGE_SUMMARY_MAX_CHARS = 200;

type Inbound = 'accept' | 'hold' | 'refuse';
const INBOUND: readonly Inbound[] = ['accept', 'hold', 'refuse'];

export interface ReachableAgent {
  handle: string;
  session_id: string;
  short_id: string;
  project_id: string;
  agent_name: string | null;
  title: string | null;
  relation: string;
  state: string;
  inbound: Inbound;
  can_receive: boolean;
}

interface PeerMessage {
  id: string;
  from_handle: string;
  from_session_id: string;
  to_handle: string;
  to_session_id: string;
  type: string;
  message: string;
  summary: string | null;
  status: string;
  created_at: string;
}

interface PeerMessageSendResult {
  status: 'delivered' | 'held' | 'refused' | 'denied' | 'expired' | 'dropped';
  message: PeerMessage | null;
  to: ReachableAgent | null;
  note: string;
}

export const MESSAGE_HELP = help`Usage: kortix sessions message <to> ["<text>"] [options]

Send a message from one session to another session of the project. The
receiving agent reads it at its next step, or a new turn starts when it is
idle. The text says it comes from another session: it is a request, never an
approval. Reads stdin when no text is given.

<to> is an agent handle (the name a session gave a child), a session id or a
prefix of 8+ characters, \`parent\`, or \`@name\`. \`kortix sessions reachable\`
lists who you can reach.

Options:
  --from <session>     The sending session (default: $KORTIX_SESSION_ID, the
                       session this CLI runs in). Required outside a session.
  --summary "<line>"   A one-line preview the receiver's person sees (max 200).
  --notify-idle        Send one notice back to the sender when the receiver's
                       turn ends. Lapses after 12 h.
  --shutdown           Ask a teammate to finish and stop (agent teams).
  --to-project <id>    Resolve <to> in another project you can prompt in.
  --project <id>       Project of the sender (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  --json               Print the send result.
  -h, --help           Show this help.

Result: delivered, held (waits up to 5 min for the receiver's person),
dropped (the same text within 60 s), or refused. Exit 0 delivered, held or
dropped; 1 refused or an API error; 2 usage error.

Limits: 16,000 characters per message, 30 messages per minute per sender.

Examples:
  kortix sessions message reviewer "The schema change landed; rebase is safe."
  kortix sessions message 3f2a1b9c "Are you done with the migration?" --notify-idle
  echo "$REPORT" | kortix sessions message parent --summary "Test run: 2 failures"
`;

export const REACHABLE_HELP = help`Usage: kortix sessions reachable [options]

List the sessions a session can message: its parent, its children, its lead
and teammates, and with --scope project every live session of the project.
Each row shows the handle \`sessions message\` takes, its state, and whether it
takes messages.

Options:
  --scope mine|project  mine (default): parent, children, lead, teammates.
                        project: every live session of the project.
  --from <session>      The asking session (default: $KORTIX_SESSION_ID).
  --project <id>        Project (default: linked).
  --host <name>         Operate against a non-default Kortix host.
  --json                Print { self, agents }.
  -h, --help            Show this help.
`;

export const INBOUND_HELP = help`Usage: kortix sessions inbound <session> [accept|hold|refuse|ls|approve <id>|deny <id>]

Choose what a session does with messages from other sessions, and decide the
messages it holds.

Modes:
  accept     Deliver each message (default for every session).
  hold       Keep each message until a person approves it. A held message
             expires after 5 minutes.
  refuse     Turn each message away; the sender reads "Not sent".

Held messages:
  ls         The messages sent to the session, newest first.
  approve <id>  Deliver one held message.
  deny <id>     Drop one held message; the sender reads that it was declined.

Without a mode it prints the session's current mode.

Options:
  --project <id>     Project of the session (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix sessions inbound 3f2a1b9c hold
  kortix sessions inbound 3f2a1b9c ls
  kortix sessions inbound 3f2a1b9c approve m_7Kq2
`;

interface Common {
  json: boolean;
  projectArg?: string;
  hostArg?: string;
}

function takeCommon(rest: string[]): Common {
  return {
    json: takeFlagBool(rest, ['--json']),
    projectArg: takeFlagValue(rest, ['--project']),
    hostArg: takeFlagValue(rest, ['--host']),
  };
}

/** A session reference (full id or a unique 8+ prefix) → the full session id, or an exit code. */
async function resolveSessionRef(client: ApiClient, projectId: string, ref: string): Promise<string | number> {
  if (SESSION_UUID_RE.test(ref)) return ref;
  if (ref.length < 8) return fail(`"${ref}" is too short: pass a session id or 8+ characters of one.`);
  const found = await expandSessionIdPrefix(client, projectId, ref);
  if (found === 'ambiguous') return fail(`"${ref}" matches more than one session: pass more characters.`);
  if (!found) {
    process.stderr.write(`${status.err(`No session ${ref} in project ${projectId}.`)}\n`);
    return 1;
  }
  return found.session_id;
}

/** The sending session: --from, else the session this CLI runs in. */
async function senderSession(client: ApiClient, projectId: string, from: string | undefined, verb: string): Promise<string | number> {
  const ref = from ?? process.env.KORTIX_SESSION_ID;
  if (!ref) return fail(`Pass --from <session>: ${verb} needs a sending session, and this CLI runs outside one.`);
  return resolveSessionRef(client, projectId, ref);
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('');
}

const short = (id: string) => id.slice(0, 8);

// ── sessions message ─────────────────────────────────────────────────────

export async function runSessionsMessage(argv: string[]): Promise<number> {
  const helped = argv.some((a) => a === '-h' || a === '--help') ? splitHelp(argv, MESSAGE_HELP) : null;
  if (helped !== null) return helped;
  const rest = [...argv];
  let common: Common;
  let from: string | undefined;
  let summary: string | undefined;
  let toProject: string | undefined;
  let notifyIdle = false;
  let shutdown = false;
  try {
    common = takeCommon(rest);
    from = takeFlagValue(rest, ['--from']);
    summary = takeFlagValue(rest, ['--summary']);
    toProject = takeFlagValue(rest, ['--to-project']);
    notifyIdle = takeFlagBool(rest, ['--notify-idle']);
    shutdown = takeFlagBool(rest, ['--shutdown']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((a) => a.startsWith('-'));
  if (unknown) return fail(`Unknown option ${unknown}. Run kortix sessions message --help.`);
  const [to, ...words] = rest;
  if (!to) return missing('<to>: a handle, a session id, `parent` or `@name`');
  let text = words.join(' ');
  if (!text && process.stdin.isTTY !== true) text = (await readStdinText()).trim();
  if (!text) return missing('the message text, or pipe it on stdin');
  if (text.length > PEER_MESSAGE_MAX_CHARS) {
    return fail(`The message has ${text.length} characters; the limit is ${PEER_MESSAGE_MAX_CHARS.toLocaleString('en-US')}. Shorten it or send a file path.`);
  }
  if (summary !== undefined && summary.trim().length > PEER_MESSAGE_SUMMARY_MAX_CHARS) {
    return fail(`--summary has ${summary.trim().length} characters; the limit is ${PEER_MESSAGE_SUMMARY_MAX_CHARS}.`);
  }

  const ctx = await resolveProjectContext({ projectArg: common.projectArg, hostArg: common.hostArg });
  if (!ctx) return 1;
  const sender = await senderSession(ctx.client, ctx.projectId, from, 'a message');
  if (typeof sender === 'number') return sender;

  const body = {
    to,
    message: text,
    ...(summary?.trim() ? { summary: summary.trim() } : {}),
    ...(notifyIdle ? { notify_when_idle: true } : {}),
    ...(shutdown ? { type: 'shutdown_request' } : {}),
    ...(toProject ? { project_id: toProject } : {}),
  };
  let result: PeerMessageSendResult;
  try {
    result = await ctx.client.post<PeerMessageSendResult>(`/projects/${ctx.projectId}/sessions/${sender}/peer-messages`, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return ambiguous(err, to, common.json);
    return surfaceApiError(err);
  }
  const ok = result.status === 'delivered' || result.status === 'held' || result.status === 'dropped';
  if (common.json) {
    emitJson(result);
    if (!ok && machineErrors()) writeMachineError({ kind: 'failed', code: `peer_message_${result.status}`, message: result.note });
    return ok ? 0 : 1;
  }
  const who = result.to ? `${C.bold}${result.to.handle}${C.reset} ${C.dim}(${result.to.short_id})${C.reset}` : to;
  if (result.status === 'delivered') {
    process.stdout.write(`${status.ok(`Delivered to ${who}`)}\n`);
    if (notifyIdle) process.stdout.write(`  ${C.dim}One notice comes back when its turn ends.${C.reset}\n`);
  } else if (result.status === 'held') {
    process.stdout.write(`${status.warn(`Held for ${result.to?.handle ?? to}'s person to approve (expires in 5 min).`)}\n`);
  } else if (result.status === 'dropped') {
    process.stdout.write(`${status.info(result.note || 'Dropped: the same text went to this session less than 60 s ago.')}\n`);
  } else {
    process.stderr.write(`${status.err(result.note || `Not sent (${result.status}).`)}\n`);
  }
  return ok ? 0 : 1;
}

/** `409 ambiguous_recipient`: name the candidates so the caller can pick one. */
function ambiguous(err: ApiError, to: string, json: boolean): number {
  const body = (err.body ?? {}) as { message?: string; candidates?: ReachableAgent[] };
  const candidates = body.candidates ?? [];
  if (json) emitJson({ error: true, code: 'ambiguous_recipient', message: body.message ?? err.message, candidates });
  if (machineErrors()) {
    writeMachineError({ kind: 'failed', status: 409, code: 'ambiguous_recipient', message: body.message ?? err.message });
    return 1;
  }
  process.stderr.write(`${status.err(`"${to}" names ${candidates.length || 'more than one'} sessions. Pass one of these:`)}\n`);
  for (const c of candidates) {
    process.stderr.write(`    ${C.cyan}${c.short_id}${C.reset}  ${pad(c.handle, 20)} ${C.dim}${c.title ?? ''}${C.reset}\n`);
  }
  return 1;
}

// ── sessions reachable ───────────────────────────────────────────────────

export async function runSessionsReachable(argv: string[]): Promise<number> {
  if (argv.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(REACHABLE_HELP);
    return 0;
  }
  const rest = [...argv];
  let common: Common;
  let from: string | undefined;
  let scope: string | undefined;
  try {
    common = takeCommon(rest);
    from = takeFlagValue(rest, ['--from']);
    scope = takeFlagValue(rest, ['--scope']);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (rest.length > 0) return fail(`Unexpected argument ${rest[0]}. Run kortix sessions reachable --help.`);
  if (scope !== undefined && scope !== 'mine' && scope !== 'project') return fail('--scope is mine or project.');

  const ctx = await resolveProjectContext({ projectArg: common.projectArg, hostArg: common.hostArg });
  if (!ctx) return 1;
  const self = await senderSession(ctx.client, ctx.projectId, from, 'reachable');
  if (typeof self === 'number') return self;

  let data: { self: ReachableAgent; agents: ReachableAgent[] };
  try {
    data = await ctx.client.get(`/projects/${ctx.projectId}/sessions/${self}/reachable?scope=${scope ?? 'mine'}`);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (common.json) {
    emitJson(data);
    return 0;
  }
  process.stdout.write(`  ${C.dim}You are${C.reset} ${C.bold}${data.self.handle}${C.reset} ${C.dim}(${data.self.short_id})${C.reset}\n`);
  if (data.agents.length === 0) {
    process.stdout.write(`  ${C.dim}No other session to reach.${scope === 'project' ? '' : ' Pass --scope project for every live session of the project.'}${C.reset}\n`);
    return 0;
  }
  const w = Math.max(6, ...data.agents.map((a) => a.handle.length));
  process.stdout.write(`\n  ${C.dim}${pad('HANDLE', w)}  ID        RELATION  STATE        INBOUND${C.reset}\n`);
  for (const a of data.agents) {
    const inbound = a.can_receive ? a.inbound : `${C.red}can't receive${C.reset}`;
    process.stdout.write(`  ${pad(a.handle, w)}  ${C.cyan}${a.short_id}${C.reset}  ${pad(a.relation, 8)}  ${pad(a.state, 11)}  ${inbound}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── sessions inbound ─────────────────────────────────────────────────────

export async function runSessionsInbound(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(INBOUND_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const rest = [...argv];
  let common: Common;
  try {
    common = takeCommon(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  const [ref, action, id, ...extra] = rest;
  if (!ref) return missing('<session>');
  if (extra.length > 0) return fail(`Unexpected argument ${extra[0]}. Run kortix sessions inbound --help.`);
  const known = [...INBOUND, 'ls', 'approve', 'deny'];
  if (action !== undefined && !known.includes(action)) return fail(`"${action}" is not one of ${known.join(', ')}.`);
  if ((action === 'approve' || action === 'deny') && !id) return missing(`the message id to ${action}`);

  const ctx = await resolveProjectContext({ projectArg: common.projectArg, hostArg: common.hostArg });
  if (!ctx) return 1;
  const sessionId = await resolveSessionRef(ctx.client, ctx.projectId, ref);
  if (typeof sessionId === 'number') return sessionId;
  const base = `/projects/${ctx.projectId}/sessions/${sessionId}`;

  try {
    if (action === undefined) {
      const session = await ctx.client.get<{ inbound?: Inbound; metadata?: Record<string, unknown> }>(base);
      const mode = session.inbound ?? (INBOUND.includes(session.metadata?.inbound as Inbound) ? (session.metadata?.inbound as Inbound) : 'accept');
      if (common.json) emitJson({ session_id: sessionId, inbound: mode });
      else process.stdout.write(`  ${C.dim}${short(sessionId)}${C.reset} takes messages: ${C.bold}${mode}${C.reset}\n`);
      return 0;
    }
    if (INBOUND.includes(action as Inbound)) {
      const out = await ctx.client.put<{ inbound: Inbound }>(`${base}/inbound`, { inbound: action });
      if (common.json) emitJson({ session_id: sessionId, inbound: out.inbound });
      else process.stdout.write(`${status.ok(`${short(sessionId)} now ${describeInbound(out.inbound)}`)}\n`);
      return 0;
    }
    if (action === 'ls') {
      const { messages } = await ctx.client.get<{ messages: PeerMessage[] }>(`${base}/peer-messages?direction=in`);
      if (common.json) {
        emitJson({ messages });
        return 0;
      }
      if (messages.length === 0) {
        process.stdout.write(`  ${C.dim}No messages to ${short(sessionId)}.${C.reset}\n`);
        return 0;
      }
      for (const m of messages) {
        const preview = (m.summary ?? m.message).replace(/\s+/g, ' ').slice(0, 80);
        const state = m.status === 'held' ? `${C.yellow}held${C.reset}` : m.status;
        process.stdout.write(`  ${C.cyan}${pad(m.id, 10)}${C.reset} ${pad(state, 9)} ${C.dim}from${C.reset} ${pad(m.from_handle, 16)} ${preview}\n`);
      }
      return 0;
    }
    const decided = await ctx.client.post<PeerMessage>(`${base}/peer-messages/${encodeURIComponent(id!)}/${action}`);
    if (common.json) emitJson(decided);
    else process.stdout.write(`${status.ok(`${action === 'approve' ? 'Delivered' : 'Declined'} the message from ${decided.from_handle}`)}\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
}

function describeInbound(mode: Inbound): string {
  if (mode === 'hold') return 'holds each message for a person to approve.';
  if (mode === 'refuse') return 'refuses messages from other sessions.';
  return 'accepts messages from other sessions.';
}
