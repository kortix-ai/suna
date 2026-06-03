import type { Auth } from './auth.ts';
import { ApiError } from './client.ts';

/**
 * The OpenCode HTTP API listens on this port inside every sandbox.
 * The Kortix API exposes it at /v1/p/{sandboxId}/4096/* with the same
 * Bearer-token auth the rest of the CLI uses.
 */
const OPENCODE_PORT = 4096;

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
async function sandboxRequest<T>(opts: RequestOpts): Promise<T> {
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

interface SandboxOpencodeOpts {
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
  };
}

// ── OpenCode response shapes (subset we use) ──────────────────────────────

interface OpencodeSession {
  id: string;
  parentID?: string | null;
  title?: string;
  version?: string;
  time?: { created?: number; updated?: number };
}

type OpencodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

export interface OpencodeMessageWithParts {
  info: OpencodeMessage;
  parts: OpencodePart[];
}

type OpencodeMessage = OpencodeUserMessage | OpencodeAssistantMessage;

interface OpencodeUserMessage {
  id: string;
  role: 'user';
  sessionID: string;
  time?: { created?: number };
}

interface OpencodeAssistantMessage {
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
