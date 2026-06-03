export type ExecutorRisk = 'read' | 'write' | 'destructive' | string;

export interface ExecutorAction {
  path: string;
  name: string;
  description: string;
  risk: ExecutorRisk;
  inputSchema: unknown;
}

export interface ExecutorConnector {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: ExecutorAction[];
}

export interface ExecutorToolMatch {
  tool: string;
  connector: string;
  action: string;
  risk: ExecutorRisk;
  description: string;
  inputSchema: unknown;
}

export interface ExecutorCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  risk?: ExecutorRisk;
  status?: string;
  reason?: string;
}

export interface ExecutorClientOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ExecutorError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class ExecutorClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ExecutorClientOptions) {
    if (!opts.apiUrl.trim()) throw new Error('apiUrl is required');
    if (!opts.token.trim()) throw new Error('token is required');
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async connectors(): Promise<ExecutorConnector[]> {
    const body = await this.request<{ connectors: ExecutorConnector[] }>('/executor/connectors');
    return body.connectors ?? [];
  }

  async tools(): Promise<ExecutorToolMatch[]> {
    return flattenCatalog(await this.connectors());
  }

  async discover(query = '', opts: { limit?: number } = {}): Promise<ExecutorToolMatch[]> {
    const q = query.toLowerCase();
    const matches: ExecutorToolMatch[] = [];
    for (const tool of await this.tools()) {
      const haystack = `${tool.tool} ${tool.description}`.toLowerCase();
      if (!q || haystack.includes(q)) {
        matches.push(tool);
      }
    }
    return matches.slice(0, opts.limit ?? 20);
  }

  async describe(tool: string): Promise<ExecutorToolMatch | null> {
    return (await this.tools()).find((candidate) => candidate.tool === tool) ?? null;
  }

  async call<T = unknown>(
    connector: string,
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<ExecutorCallResult<T>> {
    return this.request<ExecutorCallResult<T>>('/executor/call', {
      method: 'POST',
      body: { connector, action, args },
    });
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchImpl(buildUrl(this.apiUrl, path), {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const body = parseBody(text);
    if (!res.ok) {
      const message = body && typeof body === 'object'
        ? String((body as { reason?: unknown; error?: unknown; message?: unknown }).reason
          ?? (body as { error?: unknown }).error
          ?? (body as { message?: unknown }).message
          ?? `HTTP ${res.status}`)
        : `HTTP ${res.status}`;
      throw new ExecutorError(message, res.status, body);
    }
    return body as T;
  }
}

export function createExecutorClient(opts: ExecutorClientOptions): ExecutorClient {
  return new ExecutorClient(opts);
}

function flattenCatalog(connectors: ExecutorConnector[]): ExecutorToolMatch[] {
  const tools: ExecutorToolMatch[] = [];
  for (const connector of connectors) {
    for (const action of connector.actions) {
      tools.push({
        tool: `${connector.slug}.${action.path}`,
        connector: connector.slug,
        action: action.path,
        risk: action.risk,
        description: action.description || action.name,
        inputSchema: action.inputSchema,
      });
    }
  }
  return tools;
}

function normalizeApiUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildUrl(apiUrl: string, path: string): string {
  const suffix = path.startsWith('/v1/')
    ? path.slice(3)
    : path.startsWith('/')
      ? path
      : `/${path}`;
  return `${apiUrl}${suffix}`;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
