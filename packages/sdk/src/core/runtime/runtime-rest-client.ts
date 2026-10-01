/**
 * The session runtime's REST compatibility client: the routes this SDK and its
 * hosts still call on a session runtime (sessions, messages, permissions,
 * questions, files, config, providers, MCP, projects), reached through the
 * Kortix API proxy (`${backendUrl}/p/{externalId}/{port}`).
 *
 * It replaces the generated `@opencode-ai/sdk` client this package used to
 * ship, with the same method names, parameters and result: every method
 * resolves `{ data, error, request, response }` and never throws for an HTTP
 * error, so callers read it unchanged. A method not listed here is not
 * available; add its route to `ROUTES` when a caller needs it.
 *
 * `runtime-rest-client.test.ts` pins every route's method, path, query and
 * body against the requests the generated client sent.
 */
import type {
  Agent,
  AgentPartInput,
  Auth,
  Command,
  Config,
  Event,
  FileContent,
  FileNode,
  FilePartInput,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  OutputFormat,
  Path,
  PermissionRuleset,
  Project,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  Session,
  SubtaskPartInput,
  TextPartInput,
  ToolIds,
  ToolList,
  VcsFileDiff,
} from './runtime-types';
import type {
  KortixAssistantMessageInfo,
  KortixFileDiff,
  KortixFilePartSource,
  KortixMessageInfo,
  KortixPart,
  KortixSessionStatus,
  KortixTodo,
  RuntimePermissionRequest,
  RuntimeQuestionAnswer,
  RuntimeQuestionRequest,
} from './transcript-types';

// ─── Result ──────────────────────────────────────────────────────────────────

/**
 * A method's result. `error` is the parsed error body on a non-2xx answer, or
 * the thrown value when the request never got an answer (then `response` is
 * undefined).
 */
export type RuntimeResult<T> = Promise<
  ({ data: T; error: undefined } | { data: undefined; error: unknown }) & {
    request: Request;
    response: Response;
  }
>;

/** Per-call options: an abort signal and extra headers. */
export interface RuntimeRequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

/** Where a client sends its requests and how. */
export interface RuntimeClientConfig {
  /** The runtime's base URL, e.g. `${backendUrl}/p/{externalId}/8000`. */
  baseUrl: string;
  /** The fetch to send with; `authenticatedFetch` for a proxied runtime. */
  fetch?: typeof fetch;
}

/** Options of the live event stream (`global.event`). */
export interface RuntimeEventStreamOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  /** First reconnect delay; a `retry:` field from the server overrides it. Default 3000 ms. */
  sseDefaultRetryDelay?: number;
  /** Reconnect delay cap. Default 30000 ms. */
  sseMaxRetryDelay?: number;
  /** Connection attempts before the stream ends. Unlimited when absent. */
  sseMaxRetryAttempts?: number;
  /** Called when an attempt fails. */
  onSseError?: (error: unknown) => void;
}

type Scope = { directory?: string; workspace?: string };
type PromptParts = Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
type TranscriptMessage = { info: KortixMessageInfo; parts: KortixPart[] };
type Reply = { info: KortixAssistantMessageInfo; parts: KortixPart[] };
type Method<P, T> = (parameters: P, options?: RuntimeRequestOptions) => RuntimeResult<T>;
type OptionalMethod<P, T> = (parameters?: P, options?: RuntimeRequestOptions) => RuntimeResult<T>;

// ─── Client surface ──────────────────────────────────────────────────────────

export interface RuntimeClient {
  session: {
    list: OptionalMethod<
      Scope & {
        scope?: 'project';
        path?: string;
        roots?: boolean | 'true' | 'false';
        start?: number;
        search?: string;
        limit?: number;
      },
      Session[]
    >;
    get: Method<Scope & { sessionID: string }, Session>;
    create: OptionalMethod<
      Scope & {
        parentID?: string;
        title?: string;
        agent?: string;
        model?: { id: string; providerID: string; variant?: string };
        metadata?: { [key: string]: unknown };
        permission?: PermissionRuleset;
        workspaceID?: string;
      },
      Session
    >;
    delete: Method<Scope & { sessionID: string }, boolean>;
    update: Method<
      Scope & {
        sessionID: string;
        title?: string;
        metadata?: { [key: string]: unknown };
        permission?: PermissionRuleset;
        time?: { archived?: number };
      },
      Session
    >;
    status: OptionalMethod<Scope, { [sessionID: string]: KortixSessionStatus }>;
    messages: Method<Scope & { sessionID: string; limit?: number; before?: string }, TranscriptMessage[]>;
    prompt: Method<Scope & PromptInput, Reply>;
    promptAsync: Method<Scope & PromptInput, {}>;
    abort: Method<Scope & { sessionID: string }, boolean>;
    revert: Method<Scope & { sessionID: string; messageID?: string; partID?: string }, Session>;
    unrevert: Method<Scope & { sessionID: string }, Session>;
    summarize: Method<
      Scope & { sessionID: string; providerID?: string; modelID?: string; auto?: boolean },
      boolean
    >;
    command: Method<
      Scope & {
        sessionID: string;
        messageID?: string;
        agent?: string;
        model?: string;
        arguments?: string;
        command?: string;
        variant?: string;
        parts?: Array<{
          id?: string;
          type: 'file';
          mime: string;
          filename?: string;
          url: string;
          source?: KortixFilePartSource;
        }>;
      },
      Reply
    >;
    share: Method<Scope & { sessionID: string }, Session>;
    unshare: Method<Scope & { sessionID: string }, Session>;
    diff: Method<Scope & { sessionID: string; messageID?: string }, KortixFileDiff[]>;
    todo: Method<Scope & { sessionID: string }, KortixTodo[]>;
  };
  permission: {
    list: OptionalMethod<Scope, RuntimePermissionRequest[]>;
    reply: Method<
      Scope & { requestID: string; reply?: 'once' | 'always' | 'reject'; message?: string },
      boolean
    >;
  };
  question: {
    list: OptionalMethod<Scope, RuntimeQuestionRequest[]>;
    reply: Method<Scope & { requestID: string; answers?: RuntimeQuestionAnswer[] }, boolean>;
    reject: Method<Scope & { requestID: string }, boolean>;
  };
  part: {
    update: Method<
      Scope & { sessionID: string; messageID: string; partID: string; part?: KortixPart },
      KortixPart
    >;
    delete: Method<Scope & { sessionID: string; messageID: string; partID: string }, boolean>;
  };
  file: {
    list: Method<Scope & { path: string }, FileNode[]>;
    read: Method<Scope & { path: string }, FileContent>;
  };
  find: {
    files: Method<
      Scope & { query: string; dirs?: 'true' | 'false'; type?: 'file' | 'directory'; limit?: number },
      string[]
    >;
  };
  vcs: {
    diff: Method<Scope & { mode: 'git' | 'branch'; context?: number }, VcsFileDiff[]>;
  };
  global: {
    /** The live event stream. Resolves once the stream object exists; the first read connects. */
    event: (options?: RuntimeEventStreamOptions) => Promise<{ stream: AsyncGenerator<Event | string, void, unknown> }>;
    health: (options?: RuntimeRequestOptions) => RuntimeResult<{ healthy: true; version: string }>;
    dispose: (options?: RuntimeRequestOptions) => RuntimeResult<boolean>;
    config: {
      get: (options?: RuntimeRequestOptions) => RuntimeResult<Config>;
      update: OptionalMethod<{ config?: Config }, Config>;
    };
  };
  provider: {
    list: OptionalMethod<
      Scope,
      { all: Provider[]; default: { [key: string]: string }; connected: string[] }
    >;
    auth: OptionalMethod<Scope, { [providerID: string]: ProviderAuthMethod[] }>;
    oauth: {
      authorize: Method<
        Scope & { providerID: string; method?: number; inputs?: { [key: string]: string } },
        ProviderAuthAuthorization
      >;
      callback: Method<Scope & { providerID: string; method?: number; code?: string }, boolean>;
    };
  };
  auth: {
    set: Method<{ providerID: string; auth?: Auth }, boolean>;
  };
  app: {
    agents: OptionalMethod<Scope, Agent[]>;
    skills: OptionalMethod<
      Scope,
      Array<{ name: string; description?: string; location: string; content: string }>
    >;
    log: OptionalMethod<
      Scope & {
        service?: string;
        level?: 'debug' | 'info' | 'error' | 'warn';
        message?: string;
        extra?: { [key: string]: unknown };
      },
      boolean
    >;
  };
  command: {
    list: OptionalMethod<Scope, Command[]>;
  };
  tool: {
    ids: OptionalMethod<Scope, ToolIds>;
    list: Method<Scope & { provider: string; model: string }, ToolList>;
  };
  mcp: {
    status: OptionalMethod<Scope, { [name: string]: McpStatus }>;
    add: OptionalMethod<
      Scope & { name?: string; config?: McpLocalConfig | McpRemoteConfig },
      { [name: string]: McpStatus }
    >;
    connect: Method<Scope & { name: string }, boolean>;
    disconnect: Method<Scope & { name: string }, boolean>;
    auth: {
      start: Method<Scope & { name: string }, { authorizationUrl: string; oauthState: string }>;
      callback: Method<Scope & { name: string; code?: string }, McpStatus>;
      remove: Method<Scope & { name: string }, { success: true }>;
    };
  };
  project: {
    list: OptionalMethod<Scope, Project[]>;
    current: OptionalMethod<Scope, Project>;
  };
  path: {
    get: OptionalMethod<Scope, Path>;
  };
}

/** The body of `session.prompt` / `session.promptAsync`. */
interface PromptInput {
  sessionID: string;
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  tools?: { [key: string]: boolean };
  format?: OutputFormat;
  system?: string;
  variant?: string;
  parts?: PromptParts;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** `{name}` segments are filled from the parameter of that name. */
  path: string;
  /** Parameters sent as query string fields. */
  query: readonly string[];
  /** Parameters sent as fields of a JSON body. */
  body: readonly string[];
  /** A parameter that IS the JSON body. */
  bodyParam?: string;
}

const SCOPE = ['directory', 'workspace'] as const;
const PROMPT_BODY = ['messageID', 'model', 'agent', 'noReply', 'tools', 'format', 'system', 'variant', 'parts'];

const r = (
  method: Route['method'],
  path: string,
  query: readonly string[] = SCOPE,
  body: readonly string[] = [],
  bodyParam?: string,
): Route => ({ method, path, query, body, bodyParam });

/** Every route the client sends, keyed by method path (`session.list`). */
export const RUNTIME_REST_ROUTES = {
  'session.list': r('GET', '/session', [...SCOPE, 'scope', 'path', 'roots', 'start', 'search', 'limit']),
  'session.get': r('GET', '/session/{sessionID}'),
  'session.create': r('POST', '/session', SCOPE, ['parentID', 'title', 'agent', 'model', 'metadata', 'permission', 'workspaceID']),
  'session.delete': r('DELETE', '/session/{sessionID}'),
  'session.update': r('PATCH', '/session/{sessionID}', SCOPE, ['title', 'metadata', 'permission', 'time']),
  'session.status': r('GET', '/session/status'),
  'session.messages': r('GET', '/session/{sessionID}/message', [...SCOPE, 'limit', 'before']),
  'session.prompt': r('POST', '/session/{sessionID}/message', SCOPE, PROMPT_BODY),
  'session.promptAsync': r('POST', '/session/{sessionID}/prompt_async', SCOPE, PROMPT_BODY),
  'session.abort': r('POST', '/session/{sessionID}/abort'),
  'session.revert': r('POST', '/session/{sessionID}/revert', SCOPE, ['messageID', 'partID']),
  'session.unrevert': r('POST', '/session/{sessionID}/unrevert'),
  'session.summarize': r('POST', '/session/{sessionID}/summarize', SCOPE, ['providerID', 'modelID', 'auto']),
  'session.command': r('POST', '/session/{sessionID}/command', SCOPE, ['messageID', 'agent', 'model', 'arguments', 'command', 'variant', 'parts']),
  'session.share': r('POST', '/session/{sessionID}/share'),
  'session.unshare': r('DELETE', '/session/{sessionID}/share'),
  'session.diff': r('GET', '/session/{sessionID}/diff', [...SCOPE, 'messageID']),
  'session.todo': r('GET', '/session/{sessionID}/todo'),
  'permission.list': r('GET', '/permission'),
  'permission.reply': r('POST', '/permission/{requestID}/reply', SCOPE, ['reply', 'message']),
  'question.list': r('GET', '/question'),
  'question.reply': r('POST', '/question/{requestID}/reply', SCOPE, ['answers']),
  'question.reject': r('POST', '/question/{requestID}/reject'),
  'part.update': r('PATCH', '/session/{sessionID}/message/{messageID}/part/{partID}', SCOPE, [], 'part'),
  'part.delete': r('DELETE', '/session/{sessionID}/message/{messageID}/part/{partID}'),
  'file.list': r('GET', '/file', [...SCOPE, 'path']),
  'file.read': r('GET', '/file/content', [...SCOPE, 'path']),
  'find.files': r('GET', '/find/file', [...SCOPE, 'query', 'dirs', 'type', 'limit']),
  'vcs.diff': r('GET', '/vcs/diff', [...SCOPE, 'mode', 'context']),
  'global.health': r('GET', '/global/health', []),
  'global.dispose': r('POST', '/global/dispose', []),
  'global.config.get': r('GET', '/global/config', []),
  'global.config.update': r('PATCH', '/global/config', [], [], 'config'),
  'provider.list': r('GET', '/provider'),
  'provider.auth': r('GET', '/provider/auth'),
  'provider.oauth.authorize': r('POST', '/provider/{providerID}/oauth/authorize', SCOPE, ['method', 'inputs']),
  'provider.oauth.callback': r('POST', '/provider/{providerID}/oauth/callback', SCOPE, ['method', 'code']),
  'auth.set': r('PUT', '/auth/{providerID}', [], [], 'auth'),
  'app.agents': r('GET', '/agent'),
  'app.skills': r('GET', '/skill'),
  'app.log': r('POST', '/log', SCOPE, ['service', 'level', 'message', 'extra']),
  'command.list': r('GET', '/command'),
  'tool.ids': r('GET', '/experimental/tool/ids'),
  'tool.list': r('GET', '/experimental/tool', [...SCOPE, 'provider', 'model']),
  'mcp.status': r('GET', '/mcp'),
  'mcp.add': r('POST', '/mcp', SCOPE, ['name', 'config']),
  'mcp.connect': r('POST', '/mcp/{name}/connect'),
  'mcp.disconnect': r('POST', '/mcp/{name}/disconnect'),
  'mcp.auth.start': r('POST', '/mcp/{name}/auth'),
  'mcp.auth.callback': r('POST', '/mcp/{name}/auth/callback', SCOPE, ['code']),
  'mcp.auth.remove': r('DELETE', '/mcp/{name}/auth'),
  'project.list': r('GET', '/project'),
  'project.current': r('GET', '/project/current'),
  'path.get': r('GET', '/path'),
} as const satisfies Record<string, Route>;

type RouteName = keyof typeof RUNTIME_REST_ROUTES;

// ─── Transport ───────────────────────────────────────────────────────────────

function queryString(route: Route, params: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const key of route.query) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    fields.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return fields.length ? `?${fields.join('&')}` : '';
}

/** The request a route sends for `params`. */
export function buildRuntimeRequest(
  baseUrl: string,
  name: RouteName,
  params: Record<string, unknown> = {},
  options: RuntimeRequestOptions = {},
): Request {
  const route: Route = RUNTIME_REST_ROUTES[name];
  const path = route.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(params[key])));
  let body: unknown;
  let hasBody = false;
  if (route.bodyParam) {
    body = params[route.bodyParam];
    hasBody = body !== undefined;
  } else {
    for (const key of route.body) {
      if (!(key in params)) continue;
      body = { ...(body as object), [key]: params[key] };
      hasBody = true;
    }
  }
  const headers = new Headers(options.headers);
  if (hasBody) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl.replace(/\/$/, '')}${path}${queryString(route, params)}`, {
    method: route.method,
    headers,
    redirect: 'follow',
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** How a 2xx body is read, from its content type. */
function parseAs(contentType: string | null): 'json' | 'text' | 'blob' | 'formData' | 'stream' {
  if (!contentType) return 'stream';
  const type = contentType.split(';')[0]?.trim() ?? '';
  if (type.startsWith('application/json') || type.endsWith('+json')) return 'json';
  if (type === 'multipart/form-data') return 'formData';
  if (['application/', 'audio/', 'image/', 'video/'].some((prefix) => type.startsWith(prefix))) return 'blob';
  if (type.startsWith('text/')) return 'text';
  return 'json';
}

async function send(config: RuntimeClientConfig, request: Request): Promise<Record<string, unknown>> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(request);
  } catch (error) {
    return { error: error || {}, request, response: undefined };
  }
  // An HTML answer is a runtime without this route (a SPA catch-all), never data.
  if (response.headers.get('content-type') === 'text/html') {
    throw new Error('The session runtime does not serve this request (it answered text/html)');
  }
  if (response.ok) {
    const as = parseAs(response.headers.get('Content-Type'));
    if (response.status === 204 || response.headers.get('Content-Length') === '0') {
      const empty = as === 'json' ? {} : as === 'formData' ? new FormData() : as === 'stream' ? response.body : await response[as]();
      return { data: empty, request, response };
    }
    if (as === 'stream') return { data: response.body, request, response };
    if (as === 'json') {
      const text = await response.text();
      return { data: text ? JSON.parse(text) : {}, request, response };
    }
    return { data: await response[as](), request, response };
  }
  const text = await response.text();
  let error: unknown = text;
  try {
    error = JSON.parse(text);
  } catch {
    // not JSON: the text is the error
  }
  return { error: error || {}, request, response };
}

// ─── Event stream ────────────────────────────────────────────────────────────

/** Server-sent events from `url`, parsed as JSON where they are JSON. */
async function* eventStream(
  config: RuntimeClientConfig,
  url: string,
  options: RuntimeEventStreamOptions,
): AsyncGenerator<Event | string, void, unknown> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const signal = options.signal ?? new AbortController().signal;
  let retryDelay = options.sseDefaultRetryDelay ?? 3000;
  let lastEventId: string | undefined;
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      const headers = new Headers(options.headers);
      if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);
      const response = await fetchFn(new Request(url, { method: 'GET', headers, signal, redirect: 'follow' }));
      if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('No body in SSE response');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const cancel = () => {
        try {
          void reader.cancel();
        } catch {
          // already released
        }
      };
      signal.addEventListener('abort', cancel);
      try {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const data: string[] = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) data.push(line.replace(/^data:\s*/, ''));
              else if (line.startsWith('id:')) lastEventId = line.replace(/^id:\s*/, '');
              else if (line.startsWith('retry:')) {
                const parsed = Number.parseInt(line.replace(/^retry:\s*/, ''), 10);
                if (!Number.isNaN(parsed)) retryDelay = parsed;
              }
            }
            if (!data.length) continue;
            const raw = data.join('\n');
            try {
              yield JSON.parse(raw) as Event;
            } catch {
              yield raw;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      return;
    } catch (error) {
      options.onSseError?.(error);
      if (options.sseMaxRetryAttempts !== undefined && attempt >= options.sseMaxRetryAttempts) return;
      const backoff = Math.min(retryDelay * 2 ** (attempt - 1), options.sseMaxRetryDelay ?? 30000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** A client for the runtime at `config.baseUrl`. */
export function createRuntimeRestClient(config: RuntimeClientConfig): RuntimeClient {
  const call =
    (name: RouteName) =>
    (params?: Record<string, unknown>, options?: RuntimeRequestOptions) =>
      send(config, buildRuntimeRequest(config.baseUrl, name, params, options));
  const bare = (name: RouteName) => (options?: RuntimeRequestOptions) => call(name)(undefined, options);
  const client = {
    session: {
      list: call('session.list'),
      get: call('session.get'),
      create: call('session.create'),
      delete: call('session.delete'),
      update: call('session.update'),
      status: call('session.status'),
      messages: call('session.messages'),
      prompt: call('session.prompt'),
      promptAsync: call('session.promptAsync'),
      abort: call('session.abort'),
      revert: call('session.revert'),
      unrevert: call('session.unrevert'),
      summarize: call('session.summarize'),
      command: call('session.command'),
      share: call('session.share'),
      unshare: call('session.unshare'),
      diff: call('session.diff'),
      todo: call('session.todo'),
    },
    permission: { list: call('permission.list'), reply: call('permission.reply') },
    question: { list: call('question.list'), reply: call('question.reply'), reject: call('question.reject') },
    part: { update: call('part.update'), delete: call('part.delete') },
    file: { list: call('file.list'), read: call('file.read') },
    find: { files: call('find.files') },
    vcs: { diff: call('vcs.diff') },
    global: {
      event: async (options: RuntimeEventStreamOptions = {}) => ({
        stream: eventStream(config, `${config.baseUrl.replace(/\/$/, '')}/global/event`, options),
      }),
      health: bare('global.health'),
      dispose: bare('global.dispose'),
      config: { get: bare('global.config.get'), update: call('global.config.update') },
    },
    provider: {
      list: call('provider.list'),
      auth: call('provider.auth'),
      oauth: { authorize: call('provider.oauth.authorize'), callback: call('provider.oauth.callback') },
    },
    auth: { set: call('auth.set') },
    app: { agents: call('app.agents'), skills: call('app.skills'), log: call('app.log') },
    command: { list: call('command.list') },
    tool: { ids: call('tool.ids'), list: call('tool.list') },
    mcp: {
      status: call('mcp.status'),
      add: call('mcp.add'),
      connect: call('mcp.connect'),
      disconnect: call('mcp.disconnect'),
      auth: { start: call('mcp.auth.start'), callback: call('mcp.auth.callback'), remove: call('mcp.auth.remove') },
    },
    project: { list: call('project.list'), current: call('project.current') },
    path: { get: call('path.get') },
  };
  // The methods above are typed by the route table; `RuntimeClient` names their results.
  return client as unknown as RuntimeClient;
}
