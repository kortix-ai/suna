import { createInterface } from 'node:readline';
import {
  type MessageWithParts,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogPage,
  type SessionLogPageQuery,
  type SessionLogThread,
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  classifySessionLogMessage,
  findSessionAttachments,
  sessionLogCallStatus,
  sessionLogOfV1Rows,
  sessionModelPin,
  toolCallError,
  toolCallRawOutput,
} from '@kortix/sdk';
import { genuiToMarkdown } from '@kortix/sdk/genui';
import { formatRelative } from '@kortix/shared';

import type { Auth } from '../api/auth.ts';
import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  emitJson,
  locateSessionAnywhere,
  resolveProjectContext,
  shortId,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import {
  resolveSessionRuntime,
  SessionRuntimeError,
  type SessionRuntime,
} from '../session-runtime.ts';
import { C, help, pad, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { queueSessionPrompt, type CreateSessionPromptResult } from './sessions-queue.ts';
import { requireConnectedModel } from './session-model-access.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

export interface ResolvedSession extends SessionRuntime {
  /** Kortix-side API client (for PATCH/save-back). */
  ctx: NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;
}

/**
 * Common pre-flight for chat commands: locate which project (and host) the
 * session lives in — trying the active/linked one first, then scanning
 * every other logged-in host/account when it's not pinned by
 * --host/--project — fetch the Kortix session, confirm the sandbox is
 * reachable, and return a bundle of everything the caller needs.
 *
 * `cliCommand` (e.g. `"sessions chat"`) is used only to build the
 * copy-pasteable retry hint printed when the session isn't found on any
 * host you're logged into.
 *
 * Returns null on any failure (and prints a friendly message itself).
 */
export async function loadSessionForChat(
  sessionId: string,
  opts: CtxOpts,
  cliCommand = 'sessions chat',
  options: { requireRunning?: boolean } = {},
): Promise<ResolvedSession | null> {
  const found = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix ${cliCommand} ${sessionId} --host ${host}`,
  );
  if (!found) return null;
  const { client, projectId, auth, session, projectName, hostName } = found.located;
  const ctx = { client, projectId, auth };
  if (cliCommand === 'sessions chat') {
    try {
      await requireConnectedModel(client, projectId);
    } catch (error) {
      surfaceApiError(error);
      return null;
    }
  }
  if (found.switched) {
    process.stderr.write(
      `${status.ok(`Found in ${C.bold}${projectName ?? projectId}${C.reset}`)} ` +
        `${C.dim}(host ${hostName}) — using it.${C.reset}\n`,
    );
  }

  // The state check + `ensureReady()` live in the print-free core so
  // `attach-opencode.ts` (the library `apps/tui` calls) runs exactly the same
  // resolution. This function only maps its failures onto the CLI's output.
  let runtime: SessionRuntime;
  try {
    runtime = await resolveSessionRuntime({
      auth,
      client,
      projectId,
      session,
      onNotRunning: options.requireRunning === false ? 'ignore' : 'fail',
    });
  } catch (error) {
    if (error instanceof SessionRuntimeError && error.kind === 'not-running') {
      process.stderr.write(
        `${status.err(error.message)}\n` +
          `  ${C.dim}Run \`kortix sessions restart ${session.session_id}\` first.${C.reset}\n`,
      );
      return null;
    }
    surfaceApiError(error instanceof SessionRuntimeError ? error.cause : error);
    return null;
  }
  return { ...runtime, ctx };
}

const fileText = (name: string | undefined) => `${C.faded}[file${name ? ` · ${name}` : ''}]${C.reset}`;

/** One block as the text `sessions log` prints; empty for a block with nothing to read. */
function blockToText(block: SessionLogBlock, streaming: boolean): string {
  switch (block.type) {
    case 'text':
      return block.synthetic ? '' : genuiToMarkdown(block.text, { streaming });
    case 'reasoning':
      return `${C.dim}[reasoning] ${block.text}${C.reset}`;
    case 'tool_call': {
      const status = sessionLogCallStatus(block, streaming);
      // A failed call prints the SDK's error text (its `result.error`, else its result text), as the web does.
      const error = toolCallError(block);
      const output = error ?? toolCallRawOutput(block);
      return `${C.faded}[${block.name} · ${status}]${C.reset}${output ? `\n${error ? C.red : C.dim}${output}${C.reset}` : ''}`;
    }
    case 'attachment':
      return fileText(block.name);
    case 'compaction':
      return block.summary ?? '';
    case 'harness': {
      // A file the harness keeps in its own form (OpenCode inlines a text file) holds its v1 part.
      const data = block.data as { type?: unknown; filename?: unknown } | null;
      return block.kind === 'file' && data?.type === 'file' ? fileText(typeof data.filename === 'string' ? data.filename : undefined) : '';
    }
    default:
      // step and subtask blocks carry no text of their own.
      return '';
  }
}

/** A session-log message's blocks as text; a still-streaming genui block never prints the cut-off note. */
function logMessageText(message: SessionLogMessage): string {
  const streaming = message.status === 'streaming';
  return message.blocks
    .map((block) => blockToText(block, streaming))
    .filter((text) => text.length > 0)
    .join('\n');
}

/** A v1 message's text, as `sessions chat` prints it. */
export function extractMessageText(msg: MessageWithParts): string {
  const message = sessionLogOfV1Rows('', msg.info.sessionID, [msg]).threads[0]?.messages[0];
  return message ? logMessageText(message) : '';
}

/** Print one session-log message: a role header, its blocks as text, and its error. */
export function printLogMessage(message: SessionLogMessage): void {
  const role = message.kind === 'compaction' ? 'compaction' : message.role;
  const color = role === 'user' || role === 'system' ? C.green : C.cyan;
  const ts = message.created_at ? new Date(message.created_at).toLocaleTimeString() : '';
  process.stdout.write(`\n${color}${C.bold}${role}${C.reset} ${C.faded}${ts}${C.reset}\n`);
  const body = logMessageText(message);
  if (body) {
    for (const line of body.split('\n')) process.stdout.write(`  ${line}\n`);
  }
  // The SDK's error: a converted record keeps the gateway's own sentence, which `error.message` does not carry.
  const error = classifySessionLogMessage(message).error;
  if (error) process.stdout.write(`  ${C.red}error: ${error.name}: ${error.message}${C.reset}\n`);
}

/** Print one v1 message (`sessions chat`), through the same block renderer. */
export function printMessage(msg: MessageWithParts): void {
  const message = sessionLogOfV1Rows('', msg.info.sessionID, [msg]).threads[0]?.messages[0];
  if (message) printLogMessage(message);
}

/** Promise-based readline `question` (single line). */
export function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const CHAT_HELP = help`Usage: kortix sessions chat [<session-id>] [options]

Talk to a running session's agent from your terminal — the same agent you'd
chat with in the dashboard. With no session id, picks your most recent running
session (or starts one with --new).

  --prompt, -p "<text>"   Send one message, print the reply, exit (one-shot).
                          Without it, opens an interactive REPL.
  --queue                 One-shot only: put the prompt in the session's
                          DURABLE inbox instead of handing it to the runtime,
                          and return as soon as it is stored. Survives a
                          sleeping or mid-turn sandbox; manage what is waiting
                          with \`kortix sessions queue\`.
  --steer                 One-shot only: hand the prompt to the turn that is
                          running now. The agent reads it at its next step;
                          the turn does not stop. Stored like --queue, so it
                          never wakes the sandbox. With no turn running, it
                          starts one. A session that cannot steer runs it as
                          --queue.
  --json                  One-shot only: print the reply as JSON (for scripts /
                          synchronous subagent calls).
  --new                   Start a fresh session and chat with it.
  --agent <name>          Agent to run for this turn (defaults to the session's).
  --project <id>          Operate on this project id (default: linked).
  --host <name>           Operate against a non-default Kortix host.
  -h, --help              Show this help.

In the REPL: type a message + Enter to send. Ctrl-D or \`exit\` quits.`;

/**
 * `kortix sessions chat` — send prompts to a session's OpenCode agent and
 * print replies. One-shot with --prompt; interactive REPL otherwise.
 */
export async function runSessionsChat(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${CHAT_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let promptText: string | undefined;
  let agent: string | undefined;
  let wantNew = false;
  let json = false;
  let queue = false;
  let steer = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    promptText = takeFlagValue(rest, ['--prompt', '-p']);
    agent = takeFlagValue(rest, ['--agent']);
    wantNew = takeFlagBool(rest, ['--new']);
    json = takeFlagBool(rest, ['--json']);
    queue = takeFlagBool(rest, ['--queue']);
    steer = takeFlagBool(rest, ['--steer']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }
  if (queue && promptText === undefined) {
    // The inbox stores a message; there is nothing to store for a REPL, and
    // "queued" has no meaning for a turn you are sitting and watching.
    process.stderr.write(`${status.err('--queue needs --prompt "<text>".')}\n`);
    return 2;
  }
  if (steer && promptText === undefined) {
    process.stderr.write(`${status.err('--steer needs --prompt "<text>".')}\n`);
    return 2;
  }
  if (steer && queue) {
    process.stderr.write(`${status.err('Pass --steer or --queue, not both.')}\n`);
    return 2;
  }
  const inbox = queue || steer;
  const opts: CtxOpts = { projectArg, hostArg };

  // ── Resolve which session to chat with ──────────────────────────────────
  const initialPromptSubmitted =
    positional[0] === undefined && wantNew && promptText !== undefined && !inbox;
  const sessionId = await resolveChatSessionId(
    positional[0],
    wantNew,
    inbox ? undefined : promptText,
    opts,
    json,
    agent,
  );
  if (!sessionId) return 1;

  // --queue and --steer are deliberately routed BEFORE loadSessionForChat: the
  // whole point of the durable inbox is that it accepts a prompt for a session
  // whose sandbox is asleep or mid-turn, and loadSessionForChat would wake it.
  if (inbox) {
    return queuePrompt(sessionId, opts, promptText!, json, steer ? 'steer' : undefined);
  }

  const resolved = await loadSessionForChat(sessionId, opts, 'sessions chat');
  if (!resolved) return 1;

  const runtimeSessionId = resolved.runtimeSessionId;

  const extra = agent ? { agent } : undefined;

  // ── One-shot ─────────────────────────────────────────────────────────────
  if (promptText !== undefined) {
    if (initialPromptSubmitted) return waitForInitialReply(resolved, json);
    return sendAndPrint(resolved, promptText, extra, json);
  }

  // ── Interactive REPL ───────────────────────────────────────────────────────
  process.stdout.write(
    `\n${C.dim}Chatting with ${C.reset}${C.bold}${resolved.session.name ?? resolved.session.session_id.split('-')[0]}${C.reset}` +
      ` ${C.faded}(${resolved.session.agent_name})${C.reset}\n` +
      `${C.dim}Type a message and press Enter. Ctrl-D or \`exit\` to quit.${C.reset}\n`,
  );
  // Replay any prior conversation so the REPL has context on screen.
  try {
    const history = await withKortixScope(resolved.auth, async () =>
      (await resolved.handle.messages({ conversationId: runtimeSessionId, limit: 20 })).messages,
    );
    for (const msg of history) printMessage(msg);
  } catch {
    /* no history / sandbox warming — start fresh */
  }

  for (;;) {
    const line = await prompt(`\n${C.green}${C.bold}you${C.reset} `);
    const text = line.trim();
    if (text === '') continue;
    if (text === 'exit' || text === 'quit') break;
    const code = await sendAndPrint(resolved, text, extra);
    if (code !== 0) {
      // Transient sandbox error — let the user retry rather than killing the REPL.
      process.stderr.write(`${C.dim}(message failed — try again, or \`exit\`)${C.reset}\n`);
    }
  }
  process.stdout.write(`${C.dim}bye.${C.reset}\n`);
  return 0;
}

/**
 * `chat --prompt --queue` / `--steer` — hand the message to the server-side inbox and
 * return. No runtime call, so a stopped or busy session takes it just as
 * readily as an idle one; the control plane delivers it at the next boundary.
 */
async function queuePrompt(
  sessionId: string,
  opts: CtxOpts,
  text: string,
  json: boolean,
  delivery?: 'steer',
): Promise<number> {
  const flag = delivery ? '--steer' : '--queue';
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions chat ${sessionId} --prompt "…" ${flag} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  let result: CreateSessionPromptResult;
  try {
    await requireConnectedModel(client, projectId);
    result = await queueSessionPrompt(client, projectId, session, text, delivery);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(result);
    return 0;
  }
  const short = session.session_id.split('-')[0];
  if (delivery === 'steer') {
    process.stdout.write(
      `${status.ok(
        result.deduped
          ? `Already sent as ${C.bold}${result.prompt_id}${C.reset}`
          : `Sent ${C.bold}${result.prompt_id}${C.reset} to steer the running turn ${C.dim}(${result.state}). The agent reads it at its next step. Track it with \`kortix sessions queue ${short}\`.${C.reset}`,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${status.ok(
      result.deduped
        ? `Already queued as ${C.bold}${result.prompt_id}${C.reset}`
        : `Queued ${C.bold}${result.prompt_id}${C.reset} ${C.dim}(${result.state}) — \`kortix sessions queue ${session.session_id.split('-')[0]}\` to track it${C.reset}`,
    )}\n`,
  );
  return 0;
}

/** Read the reply to the `initial_prompt` submitted by session creation. */
async function waitForInitialReply(resolved: ResolvedSession, json: boolean): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const messages = await withKortixScope(resolved.auth, async () =>
        (await resolved.handle.messages({ conversationId: resolved.runtimeSessionId, limit: 10 })).messages,
      );
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.info.role !== 'assistant') continue;
        const info = message.info as MessageWithParts['info'] & {
          time?: { completed?: number };
          error?: unknown;
        };
        if (info.time?.completed == null && !info.error) break;
        if (json) emitJson(messageToJson(message));
        else printMessage(message);
        return info.error ? 1 : 0;
      }
    } catch (err) {
      if (attempt === 119) return surfaceApiError(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stderr.write(`${status.err('Timed out waiting for the initial prompt reply.')}\n`);
  return 1;
}

/**
 * Resolve the target session id: explicit positional → --new (create) →
 * most-recent running session on the project. Prints guidance + returns null
 * when nothing is usable.
 */
async function resolveChatSessionId(
  explicit: string | undefined,
  wantNew: boolean,
  initialPrompt: string | undefined,
  opts: CtxOpts,
  quiet = false,
  agent?: string,
): Promise<string | null> {
  if (explicit) return explicit;

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return null;

  if (wantNew) {
    try {
      await requireConnectedModel(ctx.client, ctx.projectId);
    } catch (error) {
      surfaceApiError(error);
      return null;
    }
    const body: Record<string, unknown> = {};
    if (initialPrompt) body.initial_prompt = initialPrompt;
    if (agent) body.agent_name = agent;
    try {
      const created = await ctx.client.post<ProjectSession>(
        `/projects/${ctx.projectId}/sessions`,
        body,
      );
      if (!quiet) {
        process.stdout.write(
          `${status.ok(`Started session ${C.bold}${created.session_id.split('-')[0]}${C.reset}`)} ${C.dim}(${created.status})${C.reset}\n`,
        );
      }
      if (created.status !== 'running') {
        if (!quiet) process.stdout.write(`  ${C.dim}Waiting for the sandbox to come up…${C.reset}\n`);
        const ready = await waitForRunning(ctx, created.session_id);
        if (!ready) return null;
      }
      return created.session_id;
    } catch (err) {
      surfaceApiError(err);
      return null;
    }
  }

  const chosen = await chooseRunningSession(ctx, 'Pick a session to chat with');
  if (chosen === 'error') return null;
  if (!chosen) {
    process.stderr.write(
      `${status.err('No running session to chat with.')}\n` +
        `  ${C.dim}Start one: ${C.reset}${C.cyan}kortix sessions chat --new${C.reset}` +
        `${C.dim}, or pass a session id.${C.reset}\n`,
    );
    return null;
  }
  return chosen.session_id;
}

/**
 * Resolve which running session to act on when the user gave no id:
 *  - 0 running   → null (caller prints a friendly "none running" message)
 *  - exactly 1   → that one (no prompt — there's nothing to choose)
 *  - >1 on a TTY → interactive picker, so a human can *select a session to
 *                  interact with* the way they would in the dashboard
 *  - >1 non-TTY  → most-recently-updated, so agents / pipes / CI stay
 *                  deterministic and never block on a prompt
 * Returns the sentinel `'error'` (after printing the API error) on failure.
 */
export async function chooseRunningSession(
  ctx: NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>,
  pickTitle: string,
): Promise<ProjectSession | null | 'error'> {
  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions`);
  } catch (err) {
    surfaceApiError(err);
    return 'error';
  }
  const running = sessions
    .filter((s) => s.status === 'running')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const first = running[0];
  if (!first) return null;
  if (running.length === 1) return first;

  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!tty) return first;

  const picked = await selectFromList<ProjectSession>({
    title: pickTitle,
    items: running.map((s) => ({
      value: s,
      label: s.name ?? s.session_id.split('-')[0] ?? s.session_id,
      sublabel: `${s.status} · ${s.session_id.split('-')[0]} · ${s.branch_name}`,
    })),
  });
  return picked ?? null;
}

/**
 * Resolve a target session id when the caller may not have passed one:
 * explicit id wins outright; otherwise resolve the project context and hand
 * off to {@link chooseRunningSession}. Shared by commands like `connect` and
 * `shell` that both need "an id, or let me pick a running one" up front.
 * Prints its own "no running session" guidance (with `startHint` appended)
 * on failure.
 */
export async function resolveRunningSessionId(
  explicit: string | undefined,
  opts: CtxOpts,
  pickTitle: string,
  startHint = 'kortix sessions new --wait',
): Promise<string | null> {
  if (explicit) return explicit;
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return null;
  const chosen = await chooseRunningSession(ctx, pickTitle);
  if (chosen === 'error') return null;
  if (!chosen) {
    process.stderr.write(
      `${status.err('No running session to connect to.')}\n` +
        `  ${C.dim}Start one: ${C.reset}${C.cyan}${startHint}${C.reset}` +
        `${C.dim}, or pass a session id.${C.reset}\n`,
    );
    return null;
  }
  return chosen.session_id;
}

/** Poll a freshly-created session until it's running (or fails / times out). */
async function waitForRunning(
  ctx: NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>,
  sessionId: string,
): Promise<boolean> {
  for (let i = 0; i < 75; i += 1) {
    let s: ProjectSession;
    try {
      s = await ctx.client.get<ProjectSession>(`/projects/${ctx.projectId}/sessions/${sessionId}`);
    } catch (err) {
      surfaceApiError(err);
      return false;
    }
    if (s.status === 'running') return true;
    if (s.status === 'failed' || s.status === 'stopped') {
      process.stderr.write(
        `${status.err(`Session ${s.status}${s.error ? `: ${s.error}` : ''}.`)}\n`,
      );
      return false;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  process.stderr.write(`${status.err('Timed out waiting for the sandbox to start.')}\n`);
  return false;
}

const LOG_HELP = help`Usage: kortix sessions log [<session-id>] [options]

Print a session agent's recent messages — a read-only peek at what an agent is
doing, without sending it anything. With no session id, uses your most recent
running session.

The messages come from the session log (kortix.session/2) the server stores
at the end of every turn, so a stopped session is never woken up just to be
read. A running session adds the messages of the turn it runs now, read live
from its sandbox. A session with no stored log yet, or a credential the log
does not answer (a session-bound token, as inside a sandbox), is read from the
v1 transcript: live while the session runs, else the copy the server saved. With the
project flag session_log on, the stored log is the only saved copy: a session with no
stored log yet is read live while it runs, else nothing. The source is noted on stderr
when the session is not read live.

  --limit, -n <N>   How many recent messages to show, per thread (default 10).
  --json            Emit the session log as JSON for scripting: the session
                    record with "schema": "kortix.session/2", "source" ("log",
                    or "v1" for a session with no stored log, converted), and
                    "threads" (root and sub-agents), each with its newest
                    messages and "has_more". A running turn's messages
                    the log does not hold yet carry
                    "ext": {"kortix": {"data": {"provisional": true}}}
                    (their seq is not stored yet). The top-level
                    "provisional": true they also carry is deprecated
                    and goes in the next release: read the ext key.
  --schema v1       Deprecated: emit the old JSON (role / text / parts per
                    root message) from the v1 transcript. Goes in the next
                    release.
  --project <id>    Operate on this project id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  -h, --help        Show this help.

Pair it with \`kortix sessions ls\` (see every session) to check up on other
agents: list them, then \`kortix sessions log <id>\` to read what any one of
them is currently doing. Aliases: \`messages\`, \`history\`.`;

/**
 * `kortix sessions log` — print a session's recent messages, rendered from
 * session-log blocks. Read-only: it never sends a prompt, so it's the safe way
 * for one agent to observe what other agents are doing.
 *
 * SOURCES. The stored session log (`GET …/log`) first: it answers while the box
 * is stopped, and holds every thread. It is journaled at each turn end, so a
 * running session appends the messages of its open turn from the live read. A
 * session with no stored log (404) reads v1 as before — live while running,
 * else the server's saved transcript (not with `session_log` on: the log is
 * the only saved copy then) — converted to the same records
 * (`sessionLogOfV1Rows`), so `--json` has one shape. `--schema v1` keeps the old
 * v1 JSON for one release.
 */
export async function runSessionsLog(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${LOG_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let limitRaw: string | undefined;
  let schemaRaw: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    limitRaw = takeFlagValue(rest, ['--limit', '-n']);
    schemaRaw = takeFlagValue(rest, ['--schema']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) {
    process.stderr.write(`${status.err(`Invalid --limit "${limitRaw}".`)}\n`);
    return 2;
  }
  const schema = schemaRaw ?? 'v2';
  if (schema !== 'v1' && schema !== 'v2') {
    process.stderr.write(`${status.err(`Invalid --schema "${schemaRaw}": use v2 (default) or v1.`)}\n`);
    return 2;
  }
  if (schema === 'v1') {
    process.stderr.write(`${C.dim}--schema v1 is deprecated and goes in the next release; the default is kortix.session/2.${C.reset}\n`);
  }
  const opts: CtxOpts = { projectArg, hostArg };

  // Resolve which session: explicit id → most-recent running.
  let sessionId = positional[0];
  if (!sessionId) {
    const ctx = await resolveProjectContext(opts);
    if (!ctx) return 1;
    const chosen = await chooseRunningSession(ctx, 'Pick a session to read');
    if (chosen === 'error') return 1;
    if (!chosen) {
      process.stderr.write(
        `${status.err('No running session.')}\n` +
          `  ${C.dim}List sessions with ${C.reset}${C.cyan}kortix sessions ls${C.reset}` +
          `${C.dim}, or pass a session id.${C.reset}\n`,
      );
      return 1;
    }
    sessionId = chosen.session_id;
  }

  const found = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions log ${sessionId} --host ${host}`,
  );
  if (!found) return 1;
  const { client, projectId, auth, session, projectName, hostName } = found.located;
  if (found.switched) {
    process.stderr.write(
      `${status.ok(`Found in ${C.bold}${projectName ?? projectId}${C.reset}`)} ` +
        `${C.dim}(host ${hostName}) — using it.${C.reset}\n`,
    );
  }

  let live: { messages: MessageWithParts[]; runtimeSessionId: string } | null = null;
  let liveError: unknown = null;
  if (session.status === 'running') {
    try {
      const runtime = await resolveSessionRuntime({ auth, client, projectId, session });
      const messages = await withKortixScope(auth, async () =>
        (await runtime.handle.messages({ conversationId: runtime.runtimeSessionId, limit })).messages,
      );
      live = { messages, runtimeSessionId: runtime.runtimeSessionId };
    } catch (err) {
      // A box that is not answering — still waking, just parked, mid-restart —
      // is not a reason to show nothing: the stored copy below is the same
      // conversation up to its last turn. The live error is reported only when
      // there is no stored copy to show instead.
      liveError = err instanceof SessionRuntimeError ? (err.cause ?? err) : err;
    }
  }
  const why = liveError !== null ? 'its sandbox is not answering' : `session is ${session.status}`;

  let stored: StoredSessionLog | null = null;
  if (schema === 'v2') {
    const handle = kortixFromAuth(auth).session(projectId, session.session_id);
    try {
      stored = await readStoredSessionLog((query) => withKortixScope(auth, () => handle.log(query)), limit);
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  let output: SessionLogOutput;
  if (stored) {
    let threads = stored.threads;
    if (live) {
      const liveThread = sessionLogOfV1Rows(session.session_id, live.runtimeSessionId, live.messages).threads[0];
      if (liveThread) threads = withLiveTurn(threads, liveThread, limit);
    } else {
      process.stderr.write(`${C.dim}Stored session log — ${why}.${C.reset}\n`);
    }
    output = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, source: 'log', ...stored.session, threads };
  } else {
    let messages: MessageWithParts[];
    let runtimeSessionId: string;
    let hasMore: boolean;
    if (live) {
      ({ messages, runtimeSessionId } = live);
      hasMore = messages.length >= limit;
    } else {
      // With `session_log` on the stored log is the only saved copy: no v1 transcript (`GET …/transcript`).
      const logOn = await sessionLogOn(auth, projectId);
      const saved: SavedTranscript = logOn ? { kind: 'none' } : await readSavedTranscript(auth, projectId, session.session_id, limit);
      if (saved.kind !== 'ok' && liveError !== null) return surfaceApiError(liveError);
      if (saved.kind === 'error') return surfaceApiError(saved.error);
      if (logOn && schema === 'v1') {
        process.stderr.write(`${status.err('--schema v1 reads the v1 transcript, which this project no longer serves (session_log is on). Drop --schema v1.')}\n`);
        return 1;
      }
      if (saved.kind === 'none') {
        process.stderr.write(
          `${status.err(`No saved transcript for session ${session.session_id} yet.`)}\n` +
            `  ${C.dim}It is saved at the end of every turn. Start the session with ` +
            `\`kortix sessions start ${session.session_id}\` to read it live.${C.reset}\n`,
        );
        return 1;
      }
      messages = saved.messages;
      runtimeSessionId = saved.runtimeSessionId ?? messages[0]?.info.sessionID ?? session.session_id;
      hasMore = saved.hasMore;
      process.stderr.write(
        `${C.dim}Saved transcript — ${why}` +
          `${saved.capturedAt ? `; saved ${saved.capturedAt}` : ''}.${C.reset}\n`,
      );
    }
    if (json && schema === 'v1') {
      process.stdout.write(`${JSON.stringify(messages.map(messageToJson), null, 2)}\n`);
      return 0;
    }
    const converted = sessionLogOfV1Rows(session.session_id, runtimeSessionId, messages);
    output = { ...converted, source: 'v1', threads: converted.threads.map((thread) => ({ ...thread, has_more: hasMore })) };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  const s = session;
  process.stdout.write(
    `\n${C.bold}${s.name ?? s.session_id.split('-')[0]}${C.reset} ` +
      `${C.faded}(${s.agent_name} · ${logHeaderState(s.status, live?.messages ?? null)})${C.reset}\n`,
  );
  const root = output.threads.find((thread) => thread.parent_thread_id === null) ?? output.threads[0];
  const messages = root?.messages ?? [];
  if (messages.length === 0) {
    process.stdout.write(`  ${C.dim}No messages yet.${C.reset}\n\n`);
    return 0;
  }
  for (const message of messages) printLogMessage(message);
  // A `[file · name]` line says a file exists; it does not say it can be
  // fetched. Point at the command that fetches it — sandbox or no sandbox.
  const stored_files = findSessionAttachments(messages).length;
  if (stored_files > 0) {
    process.stdout.write(
      `\n  ${C.dim}${stored_files} stored file${stored_files === 1 ? '' : 's'} — download with ` +
        `\`kortix sessions attachments ${s.session_id}\`.${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

/**
 * The `sessions log` header's state: the session status is the sandbox's (`running` while
 * the box is up, whatever the agent does), so it is named as such. A live read adds what the
 * agent does now (`deriveActivity`): `working` or `idle`.
 */
export function logHeaderState(status: ProjectSession['status'], live: MessageWithParts[] | null): string {
  const sandbox = `sandbox ${status}`;
  return live ? `${sandbox} · ${deriveActivity(live, status).working ? 'working' : 'idle'}` : sandbox;
}

type LogThread = SessionLogThread & { has_more: boolean };

/** What `sessions log --json` prints: the session record, where it came from, and every thread read. */
type SessionLogOutput = Record<string, unknown> & { schema: string; source: 'log' | 'v1'; threads: LogThread[] };

export interface StoredSessionLog {
  /** The session record without its threads. */
  session: SessionLogPage['session'];
  /** Every thread the log holds, in the page's order, each with its newest messages. */
  threads: LogThread[];
}

/**
 * Every thread of the session's stored log, each with its newest `limit`
 * messages, oldest first. A thread pages back by `before_seq` in windows of at
 * most `pageMax` (the route's limit). Null when the session has no stored log,
 * and when the route refuses the credential (403: an API before P4.2b refuses a
 * session-bound token).
 */
export async function readStoredSessionLog(
  log: (query?: SessionLogPageQuery) => Promise<SessionLogPage | null>,
  limit: number,
  pageMax = SAVED_WINDOW_MAX,
): Promise<StoredSessionLog | null> {
  const readThread = async (thread?: string) => {
    const messages: SessionLogMessage[] = [];
    let page: SessionLogPage | null;
    let before: number | undefined;
    do {
      page = await log({
        ...(thread !== undefined && { thread }),
        limit: Math.min(pageMax, limit - messages.length),
        ...(before !== undefined && { before_seq: before }),
      });
      if (!page) return null;
      messages.unshift(...page.messages);
      before = page.messages[0]?.seq;
    } while (page.has_more && messages.length < limit && before !== undefined);
    return { page, messages, has_more: page.has_more };
  };
  let root: Awaited<ReturnType<typeof readThread>>;
  try {
    root = await readThread();
  } catch (error) {
    // An API before P4.2b refuses a session-bound token (the sandbox's KORTIX_TOKEN) with 403: read v1 then, as without a stored log.
    if ((error as { status?: unknown } | null)?.status === 403) return null;
    throw error;
  }
  if (!root) return null;
  const threads = await Promise.all(
    root.page.threads.map(async (head) => {
      const read = head.thread_id === root.page.thread_id ? root : await readThread(head.thread_id);
      return { ...head, messages: read?.messages ?? [], has_more: read?.has_more ?? false };
    }),
  );
  return { session: root.page.session, threads };
}

/**
 * A running session's threads with the turn it runs now. The stored log is
 * journaled at each turn end, so the root thread takes the live messages it
 * does not hold yet (newer than its last), marked `ext.kortix.data.provisional: true` and,
 * deprecated for one release, a top-level `provisional: true`: their
 * seq is not stored yet. A tail keeps the seqs `fromV1` gives the live read
 * when those agree with the stored ones, else it goes above the newest stored
 * seq. A deleted message's seq is not served, so a provisional seq can differ
 * from the one the journal stores. An empty or missing root thread is the live
 * read. Only for the runtime session the root thread stores; each thread keeps
 * its newest `limit` messages, and `has_more` says when older ones exist.
 */
export function withLiveTurn(threads: LogThread[], live: SessionLogThread, limit: number): LogThread[] {
  // Both marks for one release: the top-level `provisional` (v0.13.57, deprecated) and
  // `ext.kortix.data.provisional`. An `ext.kortix.data` that is not a plain object is left as
  // it is; the top-level mark still says provisional.
  const provisional = (message: SessionLogMessage): SessionLogMessage & { provisional: true } => {
    const kortix = message.ext?.kortix;
    const data = kortix?.data;
    const plain = data === undefined || (typeof data === 'object' && data !== null && !Array.isArray(data));
    const ext = plain
      ? { ...message.ext, kortix: { ...kortix, version: kortix?.version ?? '1', data: { ...(data as Record<string, unknown> | undefined), provisional: true } } }
      : message.ext;
    return { ...message, thread_id: live.thread_id, ...(ext && { ext }), provisional: true };
  };
  const fit = (thread: SessionLogThread, messages: SessionLogMessage[], older: boolean): LogThread => ({
    ...thread,
    messages: messages.slice(-limit),
    has_more: older || messages.length > limit,
  });
  const at = threads.findIndex((thread) => thread.parent_thread_id === null);
  const root = threads[at];
  if (!root) return live.messages.length ? [fit(live, live.messages.map(provisional), false), ...threads] : threads;
  if (root.thread_id !== live.thread_id) return threads;
  const stored = new Map(root.messages.map((message) => [message.message_id, message.seq]));
  const last = root.messages[root.messages.length - 1];
  const tail = live.messages.filter((message) => !stored.has(message.message_id) && (!last || message.created_at > last.created_at));
  if (tail.length === 0) return threads;
  const max = Math.max(0, ...root.messages.map((message) => message.seq));
  const agree =
    live.messages.every((message) => (stored.get(message.message_id) ?? message.seq) === message.seq) &&
    tail.every((message) => message.seq > max);
  const numbered = tail.map((message, i) => ({ ...provisional(message), seq: agree ? message.seq : max + 1 + i }));
  const next = [...threads];
  next[at] = fit(root, [...root.messages, ...numbered], root.has_more);
  return next;
}

/**
 * The project flag `session_log`: on, the stored session log is the session's only saved
 * copy, and no v1 transcript route is read. Off when the project detail cannot be read.
 */
export async function sessionLogOn(auth: Auth, projectId: string): Promise<boolean> {
  try {
    const detail = await withKortixScope(auth, () => kortixFromAuth(auth).project(projectId).detail());
    return detail.project?.experimental?.session_log === true;
  } catch {
    return false;
  }
}

/** The mirror's largest window; the route answers 400 above it. */
const SAVED_WINDOW_MAX = 500;

export type SavedTranscript =
  | { kind: 'ok'; messages: MessageWithParts[]; capturedAt: string | null; runtimeSessionId: string | null; hasMore: boolean }
  | { kind: 'none' }
  | { kind: 'error'; error: unknown };

/**
 * The newest `limit` messages of the server's saved transcript, oldest first —
 * the same order a live read returns.
 *
 * One window holds at most {@link SAVED_WINDOW_MAX}, so a larger `--limit`
 * walks OLDER windows by `next_cursor` until it is met or the saved history
 * runs out. Through the SDK's session handle, never a hand-rolled request.
 */
export async function readSavedTranscript(
  auth: Auth,
  projectId: string,
  sessionId: string,
  limit: number,
): Promise<SavedTranscript> {
  const handle = kortixFromAuth(auth).session(projectId, sessionId);
  const windows: MessageWithParts[][] = [];
  let collected = 0;
  let capturedAt: string | null = null;
  let runtimeSessionId: string | null = null;
  let before: string | null = null;
  const seen = new Set<string>();
  try {
    do {
      const envelope = await withKortixScope(auth, () =>
        handle.transcriptSync({ limit: Math.min(SAVED_WINDOW_MAX, limit - collected), before }),
      );
      if (!envelope.available) break;
      capturedAt ??= envelope.captured_at;
      runtimeSessionId ??= envelope.runtime_session_id ?? null;
      const page = envelope.messages as unknown as MessageWithParts[];
      windows.unshift(page);
      collected += page.length;
      before = envelope.next_cursor ?? null;
      // A cursor that repeats is a server that is not advancing; stop rather
      // than print the same window forever.
      if (before !== null && seen.has(before)) break;
      if (before !== null) seen.add(before);
    } while (before !== null && collected < limit);
  } catch (error) {
    return { kind: 'error', error };
  }
  if (windows.length === 0) return { kind: 'none' };
  return { kind: 'ok', messages: windows.flat(), capturedAt, runtimeSessionId, hasMore: before !== null };
}

/** Compact, ANSI-free shape of a message for `--json` consumption. */
function messageToJson(msg: MessageWithParts): Record<string, unknown> {
  const info = msg.info as MessageWithParts['info'] & {
    time?: { created?: number; completed?: number };
    error?: { name?: string; message?: string } | null;
    agent?: string;
  };
  const text = msg.parts
    .filter(
      (p) =>
        p.type === 'text' &&
        !(p as { synthetic?: boolean }).synthetic &&
        typeof (p as { text?: string }).text === 'string',
    )
    .map((p) => (p as { text: string }).text)
    .join('\n');
  const parts = msg.parts.map((p) => {
    if (p.type === 'tool') {
      const state = (p as { state?: { status?: string } }).state;
      return { type: 'tool', tool: (p as { tool?: string }).tool, status: state?.status };
    }
    if (p.type === 'file') {
      return { type: 'file', filename: (p as { filename?: string }).filename };
    }
    return { type: p.type };
  });
  return {
    role: info.role,
    created: info.time?.created ? new Date(info.time.created).toISOString() : null,
    completed: info.time?.completed ? new Date(info.time.completed).toISOString() : null,
    error: info.error ?? null,
    text,
    parts,
  };
}

type AssistantReply = MessageWithParts & { info: Extract<MessageWithParts['info'], { role: 'assistant' }> };

/**
 * Put `text` in the session's prompt inbox (`handle.send`), then wait for the
 * reply: the last assistant message answering the new user message, once the
 * root is idle again. The inbox may place the prompt under a new id, so the
 * prompt is the user message the transcript did not hold before the send.
 */
export async function sendAndWaitForReply(
  target: Pick<SessionRuntime, 'auth' | 'handle' | 'runtimeSessionId'>,
  text: string,
  extra?: { agent?: string },
  timeoutMs = 10 * 60_000,
): Promise<AssistantReply> {
  // One assistant message per model step: the window must hold the prompt
  // and a long turn's replies. ponytail: a turn over ~200 steps outgrows it;
  // read by `after` the prompt if that happens.
  const tip = () =>
    withKortixScope(target.auth, async () =>
      (await target.handle.messages({ conversationId: target.runtimeSessionId, limit: 200 })).messages,
    );
  const before = new Set((await tip()).map((message) => message.info.id));
  await withKortixScope(target.auth, () => target.handle.send(text, extra));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const messages = await tip();
    const prompt = messages.find((message) => message.info.role === 'user' && !before.has(message.info.id));
    if (!prompt) continue;
    const reply = [...messages]
      .reverse()
      .find((message) => message.info.role === 'assistant' && message.info.parentID === prompt.info.id) as
      | AssistantReply
      | undefined;
    if (!reply || (reply.info.time.completed == null && !reply.info.error)) continue;
    const { statuses } = await withKortixScope(target.auth, () => target.handle.pending());
    const status = statuses[target.runtimeSessionId];
    if (!status || status.type === 'idle') return reply;
  }
  throw new Error('Timed out waiting for the reply.');
}

/** Send one prompt, print the assistant reply (and any error). */
async function sendAndPrint(
  resolved: ResolvedSession,
  text: string,
  extra: { agent?: string } | undefined,
  json = false,
): Promise<number> {
  // In --json mode keep stdout pure JSON (no "…thinking" spinner).
  if (!json) process.stdout.write(`${C.dim}…thinking${C.reset}\r`);
  try {
    const reply = await sendAndWaitForReply(resolved, text, extra);
    if (json) {
      emitJson(messageToJson({ info: reply.info, parts: reply.parts }));
      return reply.info.error ? 1 : 0;
    }
    process.stdout.write(`${' '.repeat(12)}\r`); // clear "…thinking"
    printMessage({ info: reply.info, parts: reply.parts });
    return reply.info.error ? 1 : 0;
  } catch (err) {
    if (!json) process.stdout.write(`${' '.repeat(12)}\r`);
    return surfaceApiError(err);
  }
}

// ── sessions status — mission control ────────────────────────────────────────

const STATUS_HELP = help`Usage: kortix sessions status [options]

Mission control: a one-line overview of every session and what each agent is
doing *right now* — for when many run in parallel. For each running session it
reads the live agent state (current tool / generating / idle + last activity).
By default shows active sessions (running / provisioning / failed); pass --all
to include stopped ones. Aliases: \`overview\`, \`ps\`.

  --all, -a         Include stopped/completed sessions.
  --json            Structured output for scripting; each session carries
                    model, its resolved model id (null when none stored).
  --project <id>    Operate on this project id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  -h, --help        Show this help.

Then talk to any of them: \`kortix sessions chat <id> --prompt "…"\`, or read
one in full: \`kortix sessions log <id>\`.`;

interface SessionActivity {
  /** True when the agent is mid-turn (generating or running a tool). */
  working: boolean;
  /** The tool currently executing, if any. */
  tool?: string;
  /** Short human label: "running bash…", "thinking…", "idle", a reply snippet. */
  summary: string;
  /** Role of the most recent message. */
  last_role?: 'user' | 'assistant';
  /** ISO timestamp of the most recent activity. */
  last_at?: string;
}

/**
 * `kortix sessions status` — overview of all sessions + live per-agent
 * activity. Running sessions get one concurrent OpenCode read each (capped),
 * so it scales to a wall of parallel sessions without a thundering herd.
 */
export async function runSessionsStatus(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${STATUS_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let all = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    all = takeFlagBool(rest, ['--all', '-a']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (rest.length > 0) {
    process.stderr.write(`${status.err(`Unexpected argument: ${rest[0]}`)}\n${STATUS_HELP}\n`);
    return 2;
  }
  const opts: CtxOpts = { projectArg, hostArg };
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const auth = ctx.auth;

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions`);
  } catch (err) {
    return surfaceApiError(err);
  }

  const shown = (
    all ? sessions : sessions.filter((s) => s.status !== 'stopped' && s.status !== 'completed')
  ).sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );

  // Pull live activity for running sessions, concurrency-capped.
  const running = shown.filter((s) => s.status === 'running');
  const activity = new Map<string, SessionActivity>();
  await mapLimit(running, 8, async (s) => {
    const a = await fetchSessionActivity(s, ctx.projectId, auth);
    if (a) activity.set(s.session_id, a);
  });

  if (json) {
    emitJson(
      shown.map((s) => ({
        session_id: s.session_id,
        name: s.name ?? null,
        status: s.status,
        branch: s.branch_name,
        agent: s.agent_name,
        // Stored resolved model pin; null = the row stores none and the
        // session follows the default chain.
        model: sessionModelPin(s),
        updated_at: s.updated_at,
        activity: activity.get(s.session_id) ?? null,
      })),
    );
    return 0;
  }

  if (shown.length === 0) {
    process.stdout.write(
      `  ${C.dim}No ${all ? '' : 'active '}sessions.${all ? '' : ' (pass --all to include stopped ones)'}${C.reset}\n`,
    );
    return 0;
  }

  const counts = countByStatus(shown);
  const headline = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  const labels = shown.map((s) => s.name ?? s.agent_name);
  const labelW = Math.max(...labels.map((l) => l.length), 4);

  process.stdout.write(`\n  ${C.dim}${headline}${C.reset}\n\n`);
  for (const s of shown) {
    const dot = statusDot(s.status);
    const label = s.name ?? s.agent_name;
    const id = shortId(s.session_id);
    const act = activity.get(s.session_id);
    const doing =
      s.status === 'running'
        ? act
          ? `${act.working ? C.yellow : C.faded}${act.summary}${C.reset}`
          : `${C.faded}—${C.reset}`
        : `${C.faded}${s.status}${C.reset}`;
    const age = formatRelative(act?.last_at ?? s.updated_at, { maxRelativeDays: null });
    process.stdout.write(
      `  ${dot} ${C.dim}${id}${C.reset}  ${pad(label, labelW)}  ${doing}  ${C.faded}${age}${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

const SESSION_ACTIVITY_PHASE_TIMEOUT_MS = 2_500;

/** Read one running session's latest message and summarize what it's doing. */
async function fetchSessionActivity(
  s: ProjectSession,
  projectId: string,
  auth: Auth,
): Promise<SessionActivity | null> {
  try {
    const handle = kortixFromAuth(auth).session(projectId, s.session_id);
    const ready = await withKortixScope(auth, () =>
      handle.ensureReady({ readyTimeoutMs: SESSION_ACTIVITY_PHASE_TIMEOUT_MS }),
    );
    // Fetch a small recent window (not just the last message): an assistant turn
    // can start — or dispatch a subagent batch that leaves a user-role message
    // newest — after the user's prompt, and classifying off ONLY the last message
    // then mislabels a busy session as "queued".
    const msgs = await withKortixScope(auth, async () =>
      (
        await handle.messages({
          conversationId: ready.runtimeSessionId,
          limit: 6,
          signal: AbortSignal.timeout(SESSION_ACTIVITY_PHASE_TIMEOUT_MS),
        })
      ).messages,
    );
    if (msgs.length === 0) return { working: false, summary: 'no messages yet' };
    return deriveActivity(msgs, s.status);
  } catch {
    // Sandbox still warming / proxy hiccup — treat as unknown, not fatal.
    return null;
  }
}

/**
 * Turn a session's recent messages + Kortix status into a compact "what's it
 * doing" summary. Reads the whole recent window (not just the newest message) so
 * an in-flight assistant turn is never missed, and honours the lifecycle status
 * so a still-booting box isn't reported as an idle/queued agent.
 */
export function deriveActivity(
  messages: MessageWithParts[],
  status: ProjectSession['status'],
): SessionActivity {
  // Lifecycle states before the agent can run describe the BOX, not a turn.
  if (status === 'provisioning' || status === 'branching') {
    return { working: true, summary: 'provisioning…' };
  }
  if (status === 'queued') {
    return { working: true, summary: 'booting…' };
  }

  const last = messages[messages.length - 1];
  if (!last) return { working: false, summary: 'no messages yet' };
  const lastInfo = last.info as MessageWithParts['info'] & {
    time?: { created?: number; completed?: number };
  };
  const at = lastInfo.time?.created ? new Date(lastInfo.time.created).toISOString() : undefined;

  // A running/pending tool ANYWHERE in the window means the agent is actively
  // working — even when the newest message is a (subagent) user-role prompt.
  let runningTool: string | undefined;
  let lastTool: string | undefined;
  for (const msg of messages) {
    for (const p of msg.parts) {
      if (p.type !== 'tool') continue;
      lastTool = (p as { tool?: string }).tool;
      const st = (p as { state?: { status?: string } }).state?.status;
      if (st === 'running' || st === 'pending') runningTool = (p as { tool?: string }).tool;
    }
  }
  if (runningTool) {
    return {
      working: true,
      tool: runningTool,
      summary: `running ${runningTool}…`,
      last_role: 'assistant',
      last_at: at,
    };
  }

  // The most-recent assistant turn: if it hasn't completed (and didn't error) the
  // agent is still generating — report "working", not "queued", even if a later
  // user-role message is technically newest.
  let latestAssistant:
    | (MessageWithParts['info'] & { time?: { completed?: number }; error?: unknown })
    | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const info = message.info;
    if (info.role === 'assistant') {
      latestAssistant = info as MessageWithParts['info'] & {
        time?: { completed?: number };
        error?: unknown;
      };
      break;
    }
  }
  if (latestAssistant && latestAssistant.time?.completed == null && !latestAssistant.error) {
    return { working: true, summary: 'working…', last_role: 'assistant', last_at: at };
  }

  // Newest message is the user's and no assistant turn has started — genuinely
  // queued, waiting for the agent to pick it up.
  if (lastInfo.role === 'user') {
    return { working: true, summary: 'queued — agent picking up…', last_role: 'user', last_at: at };
  }

  // Otherwise the last assistant turn is done (or failed) — summarize its reply. A turn still
  // streaming returned "working…" above, so a cut-off note here is real.
  const completed = lastInfo.time?.completed;
  const text = last.parts
    .filter(
      (p) =>
        p.type === 'text' &&
        !(p as { synthetic?: boolean }).synthetic &&
        typeof (p as { text?: string }).text === 'string',
    )
    .map((p) => genuiToMarkdown((p as { text: string }).text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    working: false,
    summary: text ? truncate(text, 64) : lastTool ? `idle (last: ${lastTool})` : 'idle',
    last_role: 'assistant',
    last_at: completed ? new Date(completed).toISOString() : at,
  };
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      const item = items[idx];
      if (item === undefined) continue;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function statusRank(s: string): number {
  switch (s) {
    case 'running':
      return 0;
    case 'provisioning':
    case 'starting':
    case 'restarting':
      return 1;
    case 'failed':
      return 2;
    default:
      return 3;
  }
}

function statusDot(s: string): string {
  switch (s) {
    case 'running':
      return `${C.green}●${C.reset}`;
    case 'failed':
      return `${C.red}✗${C.reset}`;
    case 'provisioning':
    case 'starting':
    case 'restarting':
      return `${C.yellow}◐${C.reset}`;
    default:
      return `${C.faded}○${C.reset}`;
  }
}

function countByStatus(sessions: ProjectSession[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions) out[s.status] = (out[s.status] ?? 0) + 1;
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
