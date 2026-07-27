/**
 * `kortix chat` on a terminal, and the destination of bare `kortix`.
 *
 * This module is the seam between the CLI's existing plumbing (auth, session
 * location, OpenCode-session healing — all reused unchanged from
 * `sessions-chat.ts`) and the streaming TUI in `../chat/`.
 *
 * It also owns the two guards that must never regress:
 *   - NON-TTY, `--json` and `--prompt` NEVER enter the TUI. They fall through
 *     to today's one-shot/REPL path, byte for byte. Agents and CI invoke these.
 *   - `acp_runtime` projects fall back to polling with an honest status line
 *     rather than streaming an event bus that is not their source of truth.
 */

import { openSessionEventStream } from '../api/sandbox-events.ts';
import { createRenderer } from '../chat/render.ts';
import { runChatTui, type ChatTuiDeps } from '../chat/tui.ts';
import { resolveProjectContext, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import {
  ensureOpencodeSession,
  loadSessionForChat,
  resolveRunningSessionId,
  runSessionsChat,
  type ResolvedSession,
} from './sessions-chat.ts';
import { createSessionAndWait } from './sessions.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** Terminals that support it stop treating a pasted newline as Enter while
 *  this is on — that is what makes a three-line paste one message (F8). */
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
/** Redraw the tail at most this often while a resize is in flight — same
 *  debounce discipline `sessions shell` uses. */
const RESIZE_DEBOUNCE_MS = 50;

/** Does this invocation get the interactive TUI, or today's non-interactive
 *  path? Exported because it is the single most damaging thing to regress. */
export function wantsInteractiveChat(argv: string[]): boolean {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  if (argv.includes('--json')) return false;
  if (argv.includes('--prompt') || argv.includes('-p')) return false;
  if (argv.includes('-h') || argv.includes('--help')) return false;
  return true;
}

/**
 * `kortix chat` — the TUI when a human is at the keyboard, the existing
 * one-shot/REPL otherwise.
 */
export async function runChat(argv: string[]): Promise<number> {
  if (!wantsInteractiveChat(argv)) return runSessionsChat(argv);

  const rest = [...argv];
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let agent: string | undefined;
  let wantNew = false;
  let verbose = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    agent = takeFlagValue(rest, ['--agent']);
    wantNew = takeFlagBool(rest, ['--new']);
    verbose = takeFlagBool(rest, ['--verbose', '-v']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }
  const opts: CtxOpts = { projectArg, hostArg };

  let sessionId = positional[0];
  if (!sessionId && wantNew) {
    const created = await createSessionForChat(opts, agent);
    if (!created) return 1;
    sessionId = created;
  }
  if (!sessionId) {
    const chosen = await resolveRunningSessionId(
      undefined,
      opts,
      'Pick a session to talk to',
      'kortix chat --new',
    );
    if (!chosen) return 1;
    sessionId = chosen;
  }

  return attachToSession(sessionId, opts, { agent, verbose });
}

/**
 * Bare `kortix`'s destination: create a session with the chosen agent, wait for
 * the sandbox to actually be ready, then drop straight into the conversation.
 *
 * Before this existed, picking an agent POSTed a session, printed four lines,
 * and returned you to your shell — usually while the sandbox was still
 * provisioning.
 */
export async function startSessionAndChat(agentName: string): Promise<number> {
  const sessionId = await createSessionForChat({}, agentName);
  if (!sessionId) return 1;
  return attachToSession(sessionId, {}, { verbose: false });
}

async function createSessionForChat(
  opts: CtxOpts,
  agent: string | undefined,
): Promise<string | null> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return null;
  const body: Record<string, unknown> = {};
  if (agent) body.agent_name = agent;
  const outcome = await createSessionAndWait(ctx, body, { wait: true });
  if (!outcome) return null;
  if (!outcome.ready) {
    // The session exists and may still come up — say how to get back to it
    // rather than leaving the user with a dead end.
    process.stderr.write(
      `  ${C.dim}The session was created — ${C.reset}${C.cyan}kortix chat ${outcome.session.session_id}${C.reset}` +
        `${C.dim} once it is running.${C.reset}\n`,
    );
    return null;
  }
  return outcome.session.session_id;
}

/**
 * Whether this project's runtime still publishes the OpenCode event bus.
 *
 * `acp_runtime` flips the transport to the ACP bridge, and
 * `packages/sdk/src/core/session/runtime-transport.ts` sets
 * `streamOpenCodeEvents: false` for it — subscribing anyway would render an
 * empty transcript forever. `GET /projects/{id}/detail` already carries the
 * effective flag map, so no API change is needed to detect this.
 */
export async function detectTransport(
  resolved: ResolvedSession,
): Promise<'stream' | 'poll'> {
  try {
    const detail = await resolved.ctx.client.get<{
      project?: { experimental?: Record<string, unknown> | null } | null;
    }>(`/projects/${resolved.ctx.projectId}/detail`);
    return detail?.project?.experimental?.acp_runtime === true ? 'poll' : 'stream';
  } catch {
    // A failed read must not block the conversation; streaming is the default
    // and degrades on its own if the bus is silent.
    return 'stream';
  }
}

async function attachToSession(
  sessionId: string,
  opts: CtxOpts,
  runOpts: { agent?: string; verbose: boolean },
): Promise<number> {
  const resolved = await loadSessionForChat(sessionId, opts, 'chat');
  if (!resolved) return 1;
  const ocSessionId = await ensureOpencodeSession(resolved);
  if (!ocSessionId) return 1;
  const transport = await detectTransport(resolved);

  const label =
    resolved.session.name ?? resolved.session.session_id.split('-')[0] ?? resolved.session.session_id;

  let rawModeOn = false;
  const cleanup = (): void => {
    // Leaving raw mode or bracketed paste enabled after a crash leaves the
    // user's shell visibly broken, so this runs on the normal exit path AND on
    // `process.exit` (R6).
    process.stdout.write(BRACKETED_PASTE_OFF);
    if (rawModeOn) {
      process.stdin.setRawMode?.(false);
      rawModeOn = false;
    }
    process.stdin.pause();
  };
  process.once('exit', cleanup);

  process.stdout.write(BRACKETED_PASTE_ON);
  process.stdin.setRawMode?.(true);
  rawModeOn = true;

  try {
    return await runChatTui({
      sessionId: resolved.session.session_id,
      label,
      agentName: resolved.session.agent_name,
      ocSessionId,
      agent: runOpts.agent,
      verbose: runOpts.verbose,
      transport,
      deps: terminalDeps(resolved),
    });
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}

function terminalDeps(resolved: ResolvedSession): ChatTuiDeps {
  const renderer = createRenderer({
    write: (text) => process.stdout.write(text),
    columns: () => process.stdout.columns,
  });
  return {
    oc: resolved.oc,
    renderer,
    openStream: (handlers) =>
      openSessionEventStream({
        auth: resolved.auth,
        proxyId: resolved.proxyId,
        port: resolved.runtimePort,
        onEvent: handlers.onEvent,
        onGapRehydrate: handlers.onGapRehydrate,
        onConnected: handlers.onConnected,
        onReconnecting: handlers.onReconnecting,
        onParked: handlers.onParked,
      }),
    attachInput: (onData) => {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
      return () => process.stdin.removeListener('data', onData);
    },
    onResize: (handler) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const debounced = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(handler, RESIZE_DEBOUNCE_MS);
      };
      process.stdout.on('resize', debounced);
      return () => {
        if (timer) clearTimeout(timer);
        process.stdout.removeListener('resize', debounced);
      };
    },
    select: (o) => selectFromList<string>(o),
    now: () => Date.now(),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle),
    env: (name) => process.env[name],
  };
}
