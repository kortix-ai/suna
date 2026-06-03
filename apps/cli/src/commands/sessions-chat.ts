import { createInterface } from 'node:readline';

import { ApiError } from '../api/client.ts';
import {
  opencodeClient,
  type OpencodeMessageWithParts,
  type OpencodePart,
} from '../api/sandbox-proxy.ts';
import { loadAuthForHost, loadAuth, type Auth } from '../api/auth.ts';
import { loadLink } from '../project-link.ts';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
} from '../command-helpers.ts';
import type { ProjectSession } from '../api/types.ts';
import { C, status } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

interface ResolvedSession {
  /** Kortix session row. */
  session: ProjectSession;
  /** Auth used (so opencodeClient builds with the right base URL). */
  auth: Auth;
  /** Convenience: bound OpenCode client. */
  oc: ReturnType<typeof opencodeClient>;
  /** The OpenCode session id INSIDE the sandbox. May need creating. */
  opencodeSessionId: string | null;
  /** Kortix-side API client (for PATCH/save-back). */
  ctx: NonNullable<ReturnType<typeof resolveProjectContext>>;
}

/**
 * Common pre-flight for chat commands: resolve project ctx, fetch the
 * Kortix session, confirm the sandbox is reachable, return a bundle of
 * everything the caller needs.
 *
 * Returns null on any failure (and prints a friendly message itself).
 */
async function loadSessionForChat(
  sessionId: string,
  opts: CtxOpts,
): Promise<ResolvedSession | null> {
  const ctx = resolveProjectContext(opts);
  if (!ctx) return null;

  let session: ProjectSession;
  try {
    session = await ctx.client.get<ProjectSession>(
      `/projects/${ctx.projectId}/sessions/${sessionId}`,
    );
  } catch (err) {
    surfaceApiError(err);
    return null;
  }

  if (session.status !== 'running') {
    process.stderr.write(
      `${status.err(`Session ${session.session_id} is ${session.status}, not running.`)}\n` +
        `  ${C.dim}Run \`kortix sessions restart ${session.session_id}\` first.${C.reset}\n`,
    );
    return null;
  }
  // The OpenCode proxy is keyed by the sandbox's *external* (provider) id,
  // which only ever appears inside sandbox_url:
  //   https://<host>/v1/p/<external-id>/8000
  // `sandbox_id` is the Kortix row id and the proxy rejects it ("sandbox not
  // found"). The external id is also ephemeral — it changes on every restart —
  // so we always derive it fresh from the just-fetched session row.
  const proxyId = proxyIdFromSession(session);
  if (!proxyId) {
    process.stderr.write(
      `${status.err('Session has no reachable sandbox yet — provisioning may not be done.')}\n` +
        `  ${C.dim}Check \`kortix sessions info ${session.session_id}\`.${C.reset}\n`,
    );
    return null;
  }

  // Pick the same auth the project context resolved with so the sandbox
  // proxy auth header matches the host the session lives on.
  const hostFromLink = !opts.hostArg ? loadLink()?.host ?? undefined : undefined;
  const hostName = opts.hostArg ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth) {
    process.stderr.write(`${status.err('Not logged in.')}\n`);
    return null;
  }

  const oc = opencodeClient({ auth, sandboxId: proxyId });
  return {
    session,
    auth,
    oc,
    opencodeSessionId: session.opencode_session_id,
    ctx,
  };
}

/**
 * Ensure the session has a working OpenCode session id. If the Kortix
 * row already has one, use it. Otherwise: list, pick the first, or
 * create one — and persist the id back to Kortix so subsequent CLI calls
 * stay glued to the same conversation.
 */
async function ensureOpencodeSession(r: ResolvedSession): Promise<string | null> {
  if (r.opencodeSessionId) return r.opencodeSessionId;

  // First try to discover an existing session inside the sandbox.
  try {
    const sessions = await r.oc.listSessions();
    const first = sessions[0];
    if (first?.id) {
      await persistOpencodeSessionId(r, first.id);
      return first.id;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status >= 500) {
      // Sandbox still booting — surface and bail. Don't try to create
      // a session against a half-up service.
      surfaceApiError(err);
      return null;
    }
    // 404/empty — fall through to create.
  }

  // Create one.
  try {
    const created = await r.oc.createSession();
    if (!created?.id) {
      process.stderr.write(`${status.err('OpenCode returned no session id.')}\n`);
      return null;
    }
    await persistOpencodeSessionId(r, created.id);
    return created.id;
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

async function persistOpencodeSessionId(
  r: ResolvedSession,
  opencodeSessionId: string,
): Promise<void> {
  try {
    await r.ctx.client.patch<ProjectSession>(
      `/projects/${r.ctx.projectId}/sessions/${r.session.session_id}`,
      { opencode_session_id: opencodeSessionId },
    );
  } catch {
    // Non-fatal — the message will still go through, the link is just
    // not pinned in our DB. The drift sync job picks this up eventually.
  }
}

/** Extract a plain-text representation of a message's parts. */
function extractMessageText(msg: OpencodeMessageWithParts): string {
  return msg.parts
    .map((p) => partToText(p))
    .filter((s) => s.length > 0)
    .join('\n');
}

function partToText(part: OpencodePart): string {
  if (part.type === 'text' && typeof (part as { text?: string }).text === 'string') {
    if ((part as { synthetic?: boolean }).synthetic) return '';
    return (part as { text: string }).text;
  }
  if (part.type === 'reasoning' && typeof (part as { text?: string }).text === 'string') {
    return `${C.dim}[reasoning] ${(part as { text: string }).text}${C.reset}`;
  }
  if (part.type === 'tool') {
    const name = (part as { tool?: string }).tool ?? 'tool';
    const state = (part as { state?: { status?: string; output?: string } }).state;
    const out = state?.output ? `\n${C.dim}${state.output}${C.reset}` : '';
    return `${C.faded}[${name}${state?.status ? ` · ${state.status}` : ''}]${C.reset}${out}`;
  }
  if (part.type === 'file') {
    const filename = (part as { filename?: string }).filename;
    return `${C.faded}[file${filename ? ` · ${filename}` : ''}]${C.reset}`;
  }
  return '';
}

function printMessage(msg: OpencodeMessageWithParts): void {
  const role = msg.info.role === 'assistant' ? 'assistant' : msg.info.role;
  const color = role === 'assistant' ? C.cyan : C.green;
  const ts = msg.info.time?.created
    ? new Date(msg.info.time.created).toLocaleTimeString()
    : '';
  process.stdout.write(
    `\n${color}${C.bold}${role}${C.reset} ${C.faded}${ts}${C.reset}\n`,
  );
  const body = extractMessageText(msg);
  if (body) {
    for (const line of body.split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
  }
  if (
    msg.info.role === 'assistant' &&
    (msg.info as { error?: { message?: string } | null }).error
  ) {
    const e = (msg.info as { error?: { message?: string } | null }).error;
    process.stdout.write(`  ${C.red}error: ${e?.message ?? 'unknown'}${C.reset}\n`);
  }
}

/** Promise-based readline `question` (single line). */
function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * The proxy id (`/v1/p/<id>/…`) is the sandbox's external/provider id, which
 * only appears embedded in sandbox_url. Falls back to sandbox_id for older
 * servers that surface no URL (proxy will then error clearly).
 */
function proxyIdFromSession(session: ProjectSession): string | null {
  if (session.sandbox_url) {
    const m = session.sandbox_url.match(/\/p\/([^/]+)\//);
    if (m?.[1]) return m[1];
  }
  return session.sandbox_id || null;
}

const CHAT_HELP = `Usage: kortix sessions chat [<session-id>] [options]

Talk to a running session's agent from your terminal — the same agent you'd
chat with in the dashboard. With no session id, picks your most recent running
session (or starts one with --new).

  --prompt, -p "<text>"   Send one message, print the reply, exit (one-shot).
                          Without it, opens an interactive REPL.
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
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    promptText = takeFlagValue(rest, ['--prompt', '-p']);
    agent = takeFlagValue(rest, ['--agent']);
    wantNew = takeFlagBool(rest, ['--new']);
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

  // ── Resolve which session to chat with ──────────────────────────────────
  const sessionId = await resolveChatSessionId(positional[0], wantNew, promptText, opts);
  if (!sessionId) return 1;

  const resolved = await loadSessionForChat(sessionId, opts);
  if (!resolved) return 1;

  const ocSessionId = await ensureOpencodeSession(resolved);
  if (!ocSessionId) return 1;

  const extra = agent ? { agent } : undefined;

  // ── One-shot ─────────────────────────────────────────────────────────────
  if (promptText !== undefined) {
    return sendAndPrint(resolved, ocSessionId, promptText, extra);
  }

  // ── Interactive REPL ───────────────────────────────────────────────────────
  process.stdout.write(
    `\n${C.dim}Chatting with ${C.reset}${C.bold}${resolved.session.name ?? resolved.session.session_id.split('-')[0]}${C.reset}` +
      ` ${C.faded}(${resolved.session.agent_name})${C.reset}\n` +
      `${C.dim}Type a message and press Enter. Ctrl-D or \`exit\` to quit.${C.reset}\n`,
  );
  // Replay any prior conversation so the REPL has context on screen.
  try {
    const history = await resolved.oc.listMessages(ocSessionId, 20);
    for (const msg of history) printMessage(msg);
  } catch {
    /* no history / sandbox warming — start fresh */
  }

  for (;;) {
    const line = await prompt(`\n${C.green}${C.bold}you${C.reset} `);
    const text = line.trim();
    if (text === '' ) continue;
    if (text === 'exit' || text === 'quit') break;
    const code = await sendAndPrint(resolved, ocSessionId, text, extra);
    if (code !== 0) {
      // Transient sandbox error — let the user retry rather than killing the REPL.
      process.stderr.write(`${C.dim}(message failed — try again, or \`exit\`)${C.reset}\n`);
    }
  }
  process.stdout.write(`${C.dim}bye.${C.reset}\n`);
  return 0;
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
): Promise<string | null> {
  if (explicit) return explicit;

  const ctx = resolveProjectContext(opts);
  if (!ctx) return null;

  if (wantNew) {
    const body: Record<string, unknown> = {};
    if (initialPrompt) body.initial_prompt = initialPrompt;
    try {
      const created = await ctx.client.post<ProjectSession>(
        `/projects/${ctx.projectId}/sessions`,
        body,
      );
      process.stdout.write(
        `${status.ok(`Started session ${C.bold}${created.session_id.split('-')[0]}${C.reset}`)} ${C.dim}(${created.status})${C.reset}\n`,
      );
      if (created.status !== 'running') {
        process.stdout.write(
          `  ${C.dim}Waiting for the sandbox to come up…${C.reset}\n`,
        );
        const ready = await waitForRunning(ctx, created.session_id);
        if (!ready) return null;
      }
      return created.session_id;
    } catch (err) {
      surfaceApiError(err);
      return null;
    }
  }

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions`);
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
  const running = sessions
    .filter((s) => s.status === 'running')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (running.length === 0) {
    process.stderr.write(
      `${status.err('No running session to chat with.')}\n` +
        `  ${C.dim}Start one: ${C.reset}${C.cyan}kortix sessions chat --new${C.reset}` +
        `${C.dim}, or pass a session id.${C.reset}\n`,
    );
    return null;
  }
  return running[0]!.session_id;
}

/** Poll a freshly-created session until it's running (or fails / times out). */
async function waitForRunning(
  ctx: NonNullable<ReturnType<typeof resolveProjectContext>>,
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
      process.stderr.write(`${status.err(`Session ${s.status}${s.error ? `: ${s.error}` : ''}.`)}\n`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  process.stderr.write(`${status.err('Timed out waiting for the sandbox to start.')}\n`);
  return false;
}

/** Send one prompt, print the assistant reply (and any error). */
async function sendAndPrint(
  resolved: ResolvedSession,
  ocSessionId: string,
  text: string,
  extra: { agent?: string } | undefined,
): Promise<number> {
  process.stdout.write(`${C.dim}…thinking${C.reset}\r`);
  try {
    const reply = await resolved.oc.sendPrompt(
      ocSessionId,
      [{ type: 'text', text }],
      extra,
    );
    process.stdout.write(`${' '.repeat(12)}\r`); // clear "…thinking"
    printMessage({ info: reply.info, parts: reply.parts });
    return reply.info.error ? 1 : 0;
  } catch (err) {
    process.stdout.write(`${' '.repeat(12)}\r`);
    return surfaceApiError(err);
  }
}
