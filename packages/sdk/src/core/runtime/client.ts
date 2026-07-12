import { authenticatedFetch } from '../http/auth';
import { isConfigured } from '../http/config';
import { ApiError } from '../http/api/errors';
import { getActiveRuntimeUrl } from '../session/server-store/active';
import type { RuntimeClient, RuntimeResult } from './wire-types';
export type * from './wire-types';
export { listEnv, setEnv, deleteEnv, env } from './env';
export { triggersRequest } from './triggers';
export {
  listKortixPty,
  createKortixPty,
  updateKortixPty,
  removeKortixPty,
  getKortixPtyWebSocketUrl,
  kortixPty,
  type KortixPty,
} from './pty';
export * from './kortix-master';

type Fetcher = typeof fetch;

const clientsByUrl = new Map<string, RuntimeClient>();
const publicClientsByUrl = new Map<string, RuntimeClient>();

export class RuntimeNotReadyError extends Error {
  constructor(message = '[kortix-runtime] Server URL not ready - session runtime is still loading') {
    super(message);
    this.name = 'RuntimeNotReadyError';
  }
}

export function getClient(): RuntimeClient {
  const url = getActiveRuntimeUrl();
  if (!url) throw new RuntimeNotReadyError();
  return getClientForUrl(url);
}

export function getClientForUrl(url: string): RuntimeClient {
  if (!url) throw new Error('[kortix-runtime] getClientForUrl called without a url');
  const existing = clientsByUrl.get(url);
  if (existing) return existing;
  if (!isConfigured()) {
    throw new Error('[kortix-runtime] No auth token provider configured - call configureKortix()/createKortix() before talking to a session runtime.');
  }
  const client = createRuntimeClient(url, authenticatedFetch as Fetcher);
  clientsByUrl.set(url, client);
  return client;
}

export function getPublicClientForUrl(url: string): RuntimeClient {
  if (!url) throw new Error('[kortix-runtime] getPublicClientForUrl called without a url');
  const existing = publicClientsByUrl.get(url);
  if (existing) return existing;
  const client = createRuntimeClient(url, fetch);
  publicClientsByUrl.set(url, client);
  return client;
}

export function dropClientForUrl(url: string): void {
  clientsByUrl.delete(url);
}

export function resetClient(): void {
  clientsByUrl.clear();
}

export function dropPublicClientForUrl(url: string): void {
  publicClientsByUrl.delete(url);
}

export function resetPublicClient(): void {
  publicClientsByUrl.clear();
}

function qs(params: Record<string, unknown> = {}): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

async function parseResponse<T>(response: Response): Promise<RuntimeResult<T>> {
  const text = await response.text().catch(() => '');
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    return { error: body ?? { message: response.statusText }, response };
  }
  return { data: body as T, response };
}

function request<T>(
  baseUrl: string,
  fetcher: Fetcher,
  method: string,
  path: string,
  body?: unknown,
): Promise<RuntimeResult<T>> {
  const headers = new Headers();
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }
  const req = new Request(`${baseUrl.replace(/\/$/, '')}${path}`, { method, headers, body: payload });
  return fetcher(req).then((response) => parseResponse<T>(response));
}

async function* sseStream(response: Response): AsyncIterable<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        try {
          yield JSON.parse(data.slice(6));
        } catch {
          yield data.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createRuntimeClient(baseUrl: string, fetcher: Fetcher): RuntimeClient {
  const call = <T = unknown>(method: string, path: string, body?: unknown) => request<T>(baseUrl, fetcher, method, path, body);
  return {
    global: {
      config: {
        get: () => call('GET', '/global/config'),
        update: ({ config }: { config: unknown }) => call('PATCH', '/global/config', config),
      },
      dispose: () => call('POST', '/global/dispose'),
      health: () => call('GET', '/global/health'),
      event: async ({ signal }: { signal: AbortSignal }) => {
        const req = new Request(`${baseUrl.replace(/\/$/, '')}/global/event`, {
          headers: { accept: 'text/event-stream' },
          signal,
        });
        const response = await fetcher(req);
        if (!response.ok) throw Object.assign(new Error(`event stream failed: ${response.status}`), { status: response.status });
        return { stream: sseStream(response) };
      },
    },
    session: {
      list: (args: Record<string, unknown> = {}) => call('GET', `/session${qs(args)}`),
      get: ({ sessionID }: { sessionID: string }) => call('GET', `/session/${encodeURIComponent(sessionID)}`),
      create: (body: unknown) => call('POST', '/session', body),
      delete: ({ sessionID }: { sessionID: string }) => call('DELETE', `/session/${encodeURIComponent(sessionID)}`),
      update: ({ sessionID, ...body }: { sessionID: string; [key: string]: unknown }) => call('PATCH', `/session/${encodeURIComponent(sessionID)}`, body),
      diff: ({ sessionID }: { sessionID: string }) => call('GET', `/session/${encodeURIComponent(sessionID)}/diff`),
      todo: ({ sessionID }: { sessionID: string }) => call('GET', `/session/${encodeURIComponent(sessionID)}/todo`),
      messages: ({ sessionID }: { sessionID: string }) => call('GET', `/session/${encodeURIComponent(sessionID)}/message`),
      summarize: ({ sessionID, ...body }: { sessionID: string; [key: string]: unknown }) => call('POST', `/session/${encodeURIComponent(sessionID)}/summarize`, body),
      command: ({ sessionID, ...body }: { sessionID: string; [key: string]: unknown }) => call('POST', `/session/${encodeURIComponent(sessionID)}/command`, body),
      promptAsync: ({ sessionID, ...body }: { sessionID: string; [key: string]: unknown }) => call('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, body),
      abort: ({ sessionID }: { sessionID: string }) => call('POST', `/session/${encodeURIComponent(sessionID)}/abort`),
      share: ({ sessionID }: { sessionID: string }) => call('POST', `/session/${encodeURIComponent(sessionID)}/share`),
      unshare: ({ sessionID }: { sessionID: string }) => call('DELETE', `/session/${encodeURIComponent(sessionID)}/share`),
      status: () => call('GET', '/session/status'),
    },
    provider: {
      list: () => call('GET', '/provider'),
      auth: () => call('GET', '/provider/auth'),
      oauth: {
        authorize: (body: unknown) => call('POST', '/provider/oauth/authorize', body),
        callback: (body: unknown) => call('POST', '/provider/oauth/callback', body),
      },
    },
    auth: {
      set: (body: unknown) => call('POST', '/auth/set', body),
      remove: (body: unknown) => call('POST', '/auth/remove', body),
    },
    instance: {
      dispose: () => call('POST', '/instance/dispose'),
    },
    app: {
      agents: (args?: Record<string, unknown>) => call('GET', `/app/agents${qs(args)}`),
      skills: () => call('GET', '/app/skills'),
      log: (body: unknown) => call('POST', '/app/log', body),
    },
    command: { list: () => call('GET', '/command') },
    permission: { reply: (body: unknown) => call('POST', '/permission/reply', body) },
    question: {
      reply: (body: unknown) => call('POST', '/question/reply', body),
      reject: (body: unknown) => call('POST', '/question/reject', body),
    },
    file: { list: (args: Record<string, unknown> = {}) => call('GET', `/file${qs(args)}`) },
    find: { files: (args: Record<string, unknown> = {}) => call('GET', `/find/file${qs(args)}`) },
    part: {
      update: (body: unknown) => call('PATCH', '/part', body),
      delete: (body: unknown) => call('DELETE', '/part', body),
    },
    project: {
      list: () => call('GET', '/project'),
      current: () => call('GET', '/project/current'),
    },
    path: { get: () => call('GET', '/path') },
    tool: {
      ids: () => call('GET', '/tool/ids'),
      list: (args: Record<string, unknown> = {}) => call('GET', `/tool${qs(args)}`),
    },
    mcp: {
      status: () => call('GET', '/mcp/status'),
      add: (body: unknown) => call('POST', '/mcp', body),
      connect: (body: unknown) => call('POST', '/mcp/connect', body),
      disconnect: (body: unknown) => call('POST', '/mcp/disconnect', body),
      auth: {
        start: (body: unknown) => call('POST', '/mcp/auth/start', body),
        callback: (body: unknown) => call('POST', '/mcp/auth/callback', body),
        remove: (body: unknown) => call('POST', '/mcp/auth/remove', body),
      },
    },
    pty: {
      list: () => call('GET', '/pty'),
      create: (body: unknown) => call('POST', '/pty', body),
      remove: (body: unknown) => call('DELETE', '/pty', body),
      update: (body: unknown) => call('PATCH', '/pty', body),
    },
  };
}

async function daemonErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed?.error || parsed?.message || text || res.statusText || `HTTP ${res.status}`;
  } catch {
    return text || res.statusText || `HTTP ${res.status}`;
  }
}

export type SystemReloadMode = 'dispose-only' | 'full';

export interface SystemReloadResult {
  success: boolean;
  mode: SystemReloadMode;
  steps: string[];
  errors: string[];
}

export async function systemReload(mode: SystemReloadMode): Promise<SystemReloadResult> {
  const url = getActiveRuntimeUrl();
  if (!url) {
    throw new ApiError('[kortix-runtime] Server URL not ready - session runtime is still loading', {
      code: 'RUNTIME_UNAVAILABLE',
    });
  }
  const response = await authenticatedFetch(`${url}/kortix/services/system/reload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new ApiError(await daemonErrorMessage(response), {
      status: response.status,
      code: 'RUNTIME_RELOAD_FAILED',
    });
  }
  return (await response.json()) as SystemReloadResult;
}
