import { createInterface } from 'node:readline';

import { ApiError } from '../api/client.ts';
import {
  opencodeClient,
  type OpencodeMessageWithParts,
  type OpencodePart,
} from '../api/sandbox-proxy.ts';
import { loadAuthForHost, loadAuth, type Auth } from '../api/auth.ts';
import { hasEnvTokenHost } from '../api/config.ts';
import { loadLink } from '../project-link.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
} from '../command-helpers.ts';
import type { ProjectSession } from '../api/types.ts';
import { selectFromList } from '../tui-select.ts';
import { C, pad, status } from '../style.ts';

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
export async function loadSessionForChat(
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
  const hostFromLink =
    !opts.hostArg && !hasEnvTokenHost() ? loadLink()?.host ?? undefined : undefined;
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
export async function ensureOpencodeSession(r: ResolvedSession): Promise<string | null> {
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
export function extractMessageText(msg: OpencodeMessageWithParts): string {
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

export function printMessage(msg: OpencodeMessageWithParts): void {
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
export function prompt(label: string): Promise<string> {
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
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    promptText = takeFlagValue(rest, ['--prompt', '-p']);
    agent = takeFlagValue(rest, ['--agent']);
    wantNew = takeFlagBool(rest, ['--new']);
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
    return sendAndPrint(resolved, ocSessionId, promptText, extra, json);
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
async function chooseRunningSession(
  ctx: NonNullable<ReturnType<typeof resolveProjectContext>>,
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
  if (running.length === 0) return null;
  if (running.length === 1) return running[0]!;

  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!tty) return running[0]!;

  const picked = await selectFromList<ProjectSession>({
    title: pickTitle,
    items: running.map((s) => ({
      value: s,
      label: s.name ?? s.session_id.split('-')[0]!,
      sublabel: `${s.status} · ${s.session_id.split('-')[0]} · ${s.branch_name}`,
    })),
  });
  return picked ?? null;
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

const LOG_HELP = `Usage: kortix sessions log [<session-id>] [options]

Print a session agent's recent messages — a read-only peek at what an agent is
doing *right now*, without sending it anything. With no session id, uses your
most recent running session.

  --limit, -n <N>   How many recent messages to show (default 10).
  --json            Emit structured JSON (role / text / parts) for scripting.
  --project <id>    Operate on this project id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  -h, --help        Show this help.

Pair it with \`kortix sessions ls\` (see every session) to check up on other
agents: list them, then \`kortix sessions log <id>\` to read what any one of
them is currently doing. Aliases: \`messages\`, \`history\`.`;

/**
 * `kortix sessions log` — print a running session's recent OpenCode messages.
 * Read-only: it never sends a prompt, so it's the safe way for one agent to
 * observe what other agents are doing. Reading requires a live sandbox, so the
 * session must be `running` (a stopped session has no sandbox to query).
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
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    limitRaw = takeFlagValue(rest, ['--limit', '-n']);
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
  const opts: CtxOpts = { projectArg, hostArg };

  // Resolve which session: explicit id → most-recent running.
  let sessionId = positional[0];
  if (!sessionId) {
    const ctx = resolveProjectContext(opts);
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

  const resolved = await loadSessionForChat(sessionId, opts);
  if (!resolved) return 1;
  const ocSessionId = await ensureOpencodeSession(resolved);
  if (!ocSessionId) return 1;

  let messages: OpencodeMessageWithParts[];
  try {
    messages = await resolved.oc.listMessages(ocSessionId, limit);
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(messages.map(messageToJson), null, 2)}\n`);
    return 0;
  }

  const s = resolved.session;
  process.stdout.write(
    `\n${C.bold}${s.name ?? s.session_id.split('-')[0]}${C.reset} ` +
      `${C.faded}(${s.agent_name} · ${s.status})${C.reset}\n`,
  );
  if (messages.length === 0) {
    process.stdout.write(`  ${C.dim}No messages yet.${C.reset}\n\n`);
    return 0;
  }
  for (const msg of messages) printMessage(msg);
  process.stdout.write('\n');
  return 0;
}

/** Compact, ANSI-free shape of a message for `--json` consumption. */
function messageToJson(msg: OpencodeMessageWithParts): Record<string, unknown> {
  const info = msg.info as OpencodeMessageWithParts['info'] & {
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

/** Send one prompt, print the assistant reply (and any error). */
async function sendAndPrint(
  resolved: ResolvedSession,
  ocSessionId: string,
  text: string,
  extra: { agent?: string } | undefined,
  json = false,
): Promise<number> {
  // In --json mode keep stdout pure JSON (no "…thinking" spinner).
  if (!json) process.stdout.write(`${C.dim}…thinking${C.reset}\r`);
  try {
    const reply = await resolved.oc.sendPrompt(
      ocSessionId,
      [{ type: 'text', text }],
      extra,
    );
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

const STATUS_HELP = `Usage: kortix sessions status [options]

Mission control: a one-line overview of every session and what each agent is
doing *right now* — for when many run in parallel. For each running session it
reads the live agent state (current tool / generating / idle + last activity).
By default shows active sessions (running / provisioning / failed); pass --all
to include stopped ones. Aliases: \`overview\`, \`ps\`.

  --all, -a         Include stopped/completed sessions.
  --json            Structured output for scripting.
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
  const opts: CtxOpts = { projectArg, hostArg };
  const ctx = resolveProjectContext(opts);
  if (!ctx) return 1;

  // Same auth the project context resolved with — needed for the OpenCode proxy.
  const hostFromLink =
    !hostArg && !hasEnvTokenHost() ? loadLink()?.host ?? undefined : undefined;
  const hostName = hostArg ?? hostFromLink;
  const auth = hostName ? loadAuthForHost(hostName) : loadAuth();
  if (!auth) {
    process.stderr.write(`${status.err('Not logged in.')}\n`);
    return 1;
  }

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(
      `/projects/${ctx.projectId}/sessions`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const shown = (all
    ? sessions
    : sessions.filter((s) => s.status !== 'stopped' && s.status !== 'completed')
  ).sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );

  // Pull live activity for running sessions, concurrency-capped.
  const running = shown.filter((s) => s.status === 'running');
  const activity = new Map<string, SessionActivity>();
  await mapLimit(running, 8, async (s) => {
    const a = await fetchSessionActivity(s, auth);
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
    const age = relAge(act?.last_at ?? s.updated_at);
    process.stdout.write(
      `  ${dot} ${C.dim}${id}${C.reset}  ${pad(label, labelW)}  ${doing}  ${C.faded}${age}${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

/** Read one running session's latest message and summarize what it's doing. */
async function fetchSessionActivity(
  s: ProjectSession,
  auth: Auth,
): Promise<SessionActivity | null> {
  const proxyId = proxyIdFromSession(s);
  if (!proxyId) return null;
  const oc = opencodeClient({ auth, sandboxId: proxyId });
  try {
    let ocId = s.opencode_session_id;
    if (!ocId) {
      const list = await oc.listSessions();
      ocId = list[0]?.id ?? null;
    }
    if (!ocId) return null;
    const msgs = await oc.listMessages(ocId, 2);
    const last = msgs[msgs.length - 1];
    if (!last) return { working: false, summary: 'no messages yet' };
    return deriveActivity(last);
  } catch {
    // Sandbox still warming / proxy hiccup — treat as unknown, not fatal.
    return null;
  }
}

/** Turn the latest message into a compact "what's it doing" summary. */
function deriveActivity(m: OpencodeMessageWithParts): SessionActivity {
  const info = m.info as OpencodeMessageWithParts['info'] & {
    time?: { created?: number; completed?: number };
  };
  const at = info.time?.created ? new Date(info.time.created).toISOString() : undefined;
  if (info.role === 'user') {
    return { working: true, summary: 'queued — agent picking up…', last_role: 'user', last_at: at };
  }
  let runningTool: string | undefined;
  let lastTool: string | undefined;
  for (const p of m.parts) {
    if (p.type === 'tool') {
      lastTool = (p as { tool?: string }).tool;
      const st = (p as { state?: { status?: string } }).state?.status;
      if (st === 'running' || st === 'pending') runningTool = (p as { tool?: string }).tool;
    }
  }
  if (runningTool) {
    return { working: true, tool: runningTool, summary: `running ${runningTool}…`, last_role: 'assistant', last_at: at };
  }
  const completed = info.time?.completed;
  if (!completed) {
    return { working: true, summary: 'thinking…', last_role: 'assistant', last_at: at };
  }
  const text = m.parts
    .filter(
      (p) =>
        p.type === 'text' &&
        !(p as { synthetic?: boolean }).synthetic &&
        typeof (p as { text?: string }).text === 'string',
    )
    .map((p) => (p as { text: string }).text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    working: false,
    summary: text ? truncate(text, 64) : lastTool ? `idle (last: ${lastTool})` : 'idle',
    last_role: 'assistant',
    last_at: new Date(completed).toISOString(),
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
      await fn(items[idx]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
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

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function relAge(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
