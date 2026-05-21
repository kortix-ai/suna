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
  if (!session.sandbox_id) {
    process.stderr.write(
      `${status.err('Session has no sandbox_id — provisioning may not be done.')}\n`,
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

  const oc = opencodeClient({ auth, sandboxId: session.sandbox_id });
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
