import type { Auth } from './auth.ts';
import { ApiError } from './client.ts';

/**
 * The OpenCode HTTP API listens on this port inside every sandbox.
 * The Kortix API exposes it at /v1/p/{sandboxId}/4096/* with the same
 * Bearer-token auth the rest of the CLI uses.
 */
export const OPENCODE_PORT = 4096;

interface RequestOpts {
  apiBase: string;
  token: string;
  sandboxId: string;
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Per-request timeout. OpenCode prompt calls block for the AI to finish,
   *  so callers can override to e.g. 5 minutes. */
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
 * Used for talking to OpenCode (port 4096) from the CLI.
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

/** Build the WebSocket URL for a raw terminal (PTY) session, mirroring what
 *  the web app's browser client connects to — same host, same `?token=`
 *  query auth (WebSocket can't set custom headers). */
export function opencodePtyWsUrl(auth: Auth, sandboxId: string, ptyId: string): string {
  const base = auth.api_base.replace(/\/+$/, '').replace(/\/v1$/, '');
  const httpBase = `${base}/v1/p/${encodeURIComponent(sandboxId)}/${OPENCODE_PORT}`;
  const wsBase = httpBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/pty/${encodeURIComponent(ptyId)}/connect?token=${encodeURIComponent(auth.token)}`;
}

export interface SandboxOpencodeOpts {
  auth: Auth;
  sandboxId: string;
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
    port: OPENCODE_PORT,
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
    /**
     * Send a prompt. This BLOCKS until OpenCode finishes generating —
     * pass a generous timeout (`timeoutMs`) for long completions.
     */
    sendPrompt: (
      sessionId: string,
      parts: OpencodePromptPart[],
      extra?: { agent?: string; model?: { providerID: string; modelID: string } },
      timeoutMs?: number,
    ) =>
      sandboxRequest<{ info: OpencodeAssistantMessage; parts: OpencodePart[] }>({
        ...base,
        path: `/session/${sessionId}/message`,
        method: 'POST',
        body: { parts, ...(extra ?? {}) },
        timeoutMs: timeoutMs ?? 5 * 60_000,
      }),
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
    listPty: () => sandboxRequest<OpencodePty[]>({ ...base, path: '/pty' }),
    createPty: (body?: {
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    }) =>
      sandboxRequest<OpencodePty>({
        ...base,
        path: '/pty',
        method: 'POST',
        body: body ?? {},
      }),
    updatePty: (ptyId: string, body: { title?: string; size?: { rows: number; cols: number } }) =>
      sandboxRequest<OpencodePty>({
        ...base,
        path: `/pty/${ptyId}`,
        method: 'PATCH',
        body,
      }),
    removePty: (ptyId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/pty/${ptyId}`,
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
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
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

/** A raw terminal (PTY) running inside the sandbox — same shape the web
 *  app's xterm-based terminal panel binds to. */
export interface OpencodePty {
  id: string;
  title?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  size?: { rows: number; cols: number };
  time?: { created?: number };
}
