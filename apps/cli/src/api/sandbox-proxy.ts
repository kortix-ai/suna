import type { Auth } from './auth.ts';
import { ApiError } from './client.ts';

const TRANSIENT_SANDBOX_STATUSES = new Set([408, 429]);
const PROMPT_ACCEPT_BACKOFF_MS = [250, 500, 1_000];
const PROMPT_POLL_INTERVAL_MS = 500;
const PROMPT_MESSAGE_LIMIT = 100;

/**
 * The sandbox daemon exposes OpenCode and PTY helpers on this port. Older CLI
 * builds talked to OpenCode's internal 4096 port directly, but live sessions are
 * proxied through the daemon URL returned by the API:
 *
 *   https://<host>/v1/p/<external-id>/8000
 *
 * Keep this as a fallback only; when a session has `sandbox_url`, callers
 * should parse the external id and runtime port from that URL.
 */
export const DEFAULT_SANDBOX_RUNTIME_PORT = 8000;
export const OPENCODE_PORT = DEFAULT_SANDBOX_RUNTIME_PORT;

interface RequestOpts {
  apiBase: string;
  token: string;
  sandboxId: string;
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Per-request timeout. */
  timeoutMs?: number;
}

function joinProxyUrl(opts: RequestOpts): string {
  const base = opts.apiBase.replace(/\/+$/, '');
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`,
        )
        .join('&')
    : '';
  return `${base}/v1/p/${opts.sandboxId}/${opts.port}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Make an HTTP call against a sandbox service through the Kortix proxy.
 * Used for talking to OpenCode through the sandbox daemon from the CLI.
 */
export async function sandboxRequest<T>(opts: RequestOpts): Promise<T> {
  const url = joinProxyUrl(opts);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, `sandbox request timed out after ${timeoutMs}ms`);
    }
    throw new ApiError(0, `network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload && typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : typeof payload === 'object' && payload && 'message' in payload && typeof (payload as { message: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

function isTransientSandboxError(error: unknown): boolean {
  return error instanceof ApiError &&
    (error.status === 0 || error.status >= 500 || TRANSIENT_SANDBOX_STATUSES.has(error.status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastPromptIdTimestamp = 0;
let promptIdCounter = 0;

/** Generate the ascending OpenCode message-id shape accepted by prompt_async.
 * Reusing this stable id across a transient submit retry makes the logical
 * prompt idempotent even if the proxy lost the first 204 response. */
function promptMessageId(): string {
  const now = Date.now();
  if (now !== lastPromptIdTimestamp) {
    lastPromptIdTimestamp = now;
    promptIdCounter = 0;
  }
  promptIdCounter += 1;
  const encoded = BigInt(now) * BigInt(0x1000) + BigInt(promptIdCounter);
  // OpenCode writes the encoded value into six bytes, retaining the low
  // 48 bits. slice(-12) mirrors that Buffer behavior exactly.
  const timestamp = encoded.toString(16).padStart(12, '0').slice(-12);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let random = '';
  for (const byte of bytes) random += chars[byte % chars.length];
  return `msg_${timestamp}${random}`;
}

function completedReplyFor(
  messages: OpencodeMessageWithParts[],
  parentID: string,
): OpencodeMessageWithParts | null {
  let latest: OpencodeMessageWithParts | null = null;
  for (const message of messages) {
    if (message.info.role !== 'assistant' || message.info.parentID !== parentID) continue;
    if (message.info.time?.completed === undefined && !message.info.error) continue;
    if (!message.info.error && (message.info.finish === 'tool-calls' || message.info.finish === 'unknown')) continue;
    if (!latest) {
      latest = message;
      continue;
    }
    const created = message.info.time?.created ?? 0;
    const latestCreated = latest.info.time?.created ?? 0;
    if (created > latestCreated || (created === latestCreated && message.info.id > latest.info.id)) {
      latest = message;
    }
  }
  return latest;
}

async function sessionIsIdle(
  base: Pick<RequestOpts, 'apiBase' | 'token' | 'sandboxId' | 'port'>,
  sessionId: string,
  deadline: number,
): Promise<boolean> {
  const statuses = await sandboxRequest<Record<string, { type?: string }>>({
    ...base,
    path: '/session/status',
    timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
  });
  const status = statuses[sessionId];
  // OpenCode may omit idle sessions from the active-status map.
  return status === undefined || status.type === 'idle';
}

async function promptWasAccepted(
  base: Pick<RequestOpts, 'apiBase' | 'token' | 'sandboxId' | 'port'>,
  sessionId: string,
  messageID: string,
  deadline: number,
): Promise<boolean> {
  try {
    const message = await sandboxRequest<OpencodeMessageWithParts>({
      ...base,
      path: `/session/${sessionId}/message/${messageID}`,
      timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
    });
    return message.info.role === 'user' && message.info.id === messageID;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    if (isTransientSandboxError(error)) return false;
    throw error;
  }
}

async function submitPromptAsync(
  base: Pick<RequestOpts, 'apiBase' | 'token' | 'sandboxId' | 'port'>,
  sessionId: string,
  body: Record<string, unknown>,
  deadline: number,
): Promise<void> {
  let lastSubmitError: unknown;

  for (let attempt = 0; attempt <= PROMPT_ACCEPT_BACKOFF_MS.length; attempt += 1) {
    try {
      await sandboxRequest<null>({
        ...base,
        path: `/session/${sessionId}/prompt_async`,
        method: 'POST',
        body,
        timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())),
      });
      return;
    } catch (error) {
      lastSubmitError = error;
      const backoff = PROMPT_ACCEPT_BACKOFF_MS[attempt];
      if (!isTransientSandboxError(error) || backoff === undefined || Date.now() + backoff >= deadline) {
        throw error;
      }
      // A proxy may have delivered the initial request but lost OpenCode's
      // 204. Check the new stable user-message id before retrying so an
      // ambiguous 502 cannot enqueue the logical prompt twice.
      if (await promptWasAccepted(base, sessionId, String(body.messageID), deadline)) {
        return;
      }
      await sleep(backoff);
    }
  }
  if (lastSubmitError) throw lastSubmitError;
}

/**
 * Submit a CLI chat turn through OpenCode's short-lived prompt_async endpoint,
 * then wait for the exact assistant reply using idempotent message reads.
 *
 * The previous synchronous POST /message kept the API→sandbox proxy request
 * open for the whole model/tool turn. Cloud load balancers close that request
 * around 60–70 seconds with a 502 even though OpenCode continues working.
 * prompt_async returns 204 immediately, so no long-lived proxy request exists;
 * transient gateway errors while accepting or polling are absorbed within the
 * caller's existing five-minute turn deadline.
 */
async function sendPromptAsyncAndWait(
  base: Pick<RequestOpts, 'apiBase' | 'token' | 'sandboxId' | 'port'>,
  sessionId: string,
  parts: OpencodePromptPart[],
  extra: { agent?: string; model?: { providerID: string; modelID: string } } | undefined,
  timeoutMs: number,
): Promise<{ info: OpencodeAssistantMessage; parts: OpencodePart[] }> {
  const deadline = Date.now() + timeoutMs;
  const messageID = promptMessageId();
  const body = { parts, messageID, ...(extra ?? {}) };
  await submitPromptAsync(base, sessionId, body, deadline);

  while (Date.now() < deadline) {
    try {
      const messages = await sandboxRequest<OpencodeMessageWithParts[]>({
        ...base,
        path: `/session/${sessionId}/message`,
        query: { limit: String(PROMPT_MESSAGE_LIMIT) },
        timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())),
      });
      const reply = completedReplyFor(messages, messageID);
      // Tool turns can emit several completed assistant messages with the same
      // parent user id. Only return once the run is idle, then select the most
      // recent one so the CLI prints the final answer instead of an empty
      // completed tool step.
      if (reply && await sessionIsIdle(base, sessionId, deadline)) {
        return { info: reply.info as OpencodeAssistantMessage, parts: reply.parts };
      }
    } catch (error) {
      if (!isTransientSandboxError(error)) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(PROMPT_POLL_INTERVAL_MS, remaining));
  }

  throw new ApiError(0, `agent reply timed out after ${timeoutMs}ms`);
}

/** Build the WebSocket URL for a raw terminal (PTY) session, mirroring what
 *  the web app's browser client connects to — same host, same `?token=`
 *  query auth (WebSocket can't set custom headers). Reaches Kortix's own
 *  `/kortix/pty` implementation in the sandbox daemon (routes/pty.ts),
 *  independent of whatever agent runtime (OpenCode today) is running — same
 *  daemon port, same proxy, same auth as everything else, just a different
 *  path than OpenCode's own (now-unused-by-the-CLI) `/pty`. */
export function kortixPtyWsUrl(auth: Auth, sandboxId: string, ptyId: string): string {
  return kortixPtyWsUrlForPort(auth, sandboxId, DEFAULT_SANDBOX_RUNTIME_PORT, ptyId);
}

export function kortixPtyWsUrlForPort(
  auth: Auth,
  sandboxId: string,
  port: number,
  ptyId: string,
): string {
  const base = auth.api_base.replace(/\/+$/, '').replace(/\/v1$/, '');
  const httpBase = `${base}/v1/p/${encodeURIComponent(sandboxId)}/${port}`;
  const wsBase = httpBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/kortix/pty/${encodeURIComponent(ptyId)}/connect?token=${encodeURIComponent(auth.token)}`;
}

export interface SandboxOpencodeOpts {
  auth: Auth;
  sandboxId: string;
  port?: number;
}

/**
 * Convenience builder that returns OpenCode HTTP helpers bound to a
 * specific sandbox.
 */
export function opencodeClient(opts: SandboxOpencodeOpts) {
  const { auth, sandboxId } = opts;
  const base = {
    apiBase: auth.api_base,
    token: auth.token,
    sandboxId,
    port: opts.port ?? DEFAULT_SANDBOX_RUNTIME_PORT,
  };
  return {
    listSessions: () =>
      sandboxRequest<OpencodeSession[]>({ ...base, path: '/session' }),
    createSession: (body?: { title?: string; parentID?: string }) =>
      sandboxRequest<OpencodeSession>({
        ...base,
        path: '/session',
        method: 'POST',
        body: body ?? {},
      }),
    getSession: (sessionId: string) =>
      sandboxRequest<OpencodeSession>({ ...base, path: `/session/${sessionId}` }),
    deleteSession: (sessionId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/session/${sessionId}`,
        method: 'DELETE',
      }),
    listMessages: (sessionId: string, limit?: number) =>
      sandboxRequest<OpencodeMessageWithParts[]>({
        ...base,
        path: `/session/${sessionId}/message`,
        query: { limit: limit ? String(limit) : undefined },
      }),
    /** Submit a prompt asynchronously, then poll for its completed reply. */
    sendPrompt: (
      sessionId: string,
      parts: OpencodePromptPart[],
      extra?: { agent?: string; model?: { providerID: string; modelID: string } },
      timeoutMs?: number,
    ) =>
      sendPromptAsyncAndWait(base, sessionId, parts, extra, timeoutMs ?? 5 * 60_000),
    abortSession: (sessionId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/session/${sessionId}/abort`,
        method: 'POST',
        body: {},
      }),
    listPermissions: () =>
      sandboxRequest<OpencodePermissionRequest[]>({ ...base, path: '/permission' }),
    replyPermission: (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/permission/${requestId}/reply`,
        method: 'POST',
        body: { reply, ...(message ? { message } : {}) },
      }),
    listQuestions: () =>
      sandboxRequest<OpencodeQuestionRequest[]>({ ...base, path: '/question' }),
    replyQuestion: (requestId: string, answers: string[][]) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/question/${requestId}/reply`,
        method: 'POST',
        body: { answers },
      }),
    rejectQuestion: (requestId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/question/${requestId}/reject`,
        method: 'POST',
        body: {},
      }),
    listPty: () => sandboxRequest<OpencodePty[]>({ ...base, path: '/kortix/pty' }),
    createPty: (body?: {
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    }) =>
      sandboxRequest<OpencodePty>({
        ...base,
        path: '/kortix/pty',
        method: 'POST',
        body: body ?? {},
      }),
    updatePty: (ptyId: string, body: { title?: string; size?: { rows: number; cols: number } }) =>
      sandboxRequest<OpencodePty>({
        ...base,
        path: `/kortix/pty/${ptyId}`,
        method: 'PATCH',
        body,
      }),
    removePty: (ptyId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/kortix/pty/${ptyId}`,
        method: 'DELETE',
      }),
  };
}

// ── OpenCode response shapes (subset we use) ──────────────────────────────

export interface OpencodeSession {
  id: string;
  parentID?: string | null;
  title?: string;
  version?: string;
  time?: { created?: number; updated?: number };
}

export type OpencodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

export interface OpencodeMessageWithParts {
  info: OpencodeMessage;
  parts: OpencodePart[];
}

export type OpencodeMessage = OpencodeUserMessage | OpencodeAssistantMessage;

export interface OpencodeUserMessage {
  id: string;
  role: 'user';
  sessionID: string;
  time?: { created?: number };
}

export interface OpencodeAssistantMessage {
  id: string;
  role: 'assistant';
  sessionID: string;
  /** User message that started this turn. */
  parentID?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
  finish?: string;
  modelID?: string;
  providerID?: string;
}

export type OpencodePart =
  | { type: 'text'; text: string; synthetic?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; tool: string; state?: { status?: string; output?: string } }
  | { type: 'file'; mime?: string; filename?: string; url?: string }
  | { type: string; [k: string]: unknown };

/** A pending tool-permission ask (OpenCode holds the tool call open until
 *  `/permission/{id}/reply`). */
export interface OpencodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export interface OpencodeQuestionOption {
  label: string;
  value?: string;
  hint?: string;
}

export interface OpencodeQuestionInfo {
  question: string;
  header: string;
  options: OpencodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** A pending question the agent asked (blocks the turn until answered). */
export interface OpencodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: OpencodeQuestionInfo[];
  tool?: { messageID: string; callID: string };
}

/** A raw terminal (PTY) running inside the sandbox — Kortix's own
 *  implementation (routes/pty.ts in the sandbox daemon), independent of
 *  whatever agent runtime is running. Same shape the web app's terminal
 *  panel binds to. */
export interface OpencodePty {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
}
