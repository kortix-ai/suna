import {
  ApiError,
  configureKortix,
  createKortix,
  type ConnectorAttachmentUploadInput,
  type ConnectorAttachmentUploadResult,
} from '@kortix/sdk';

/** @deprecated Use Connector terminology from `@kortix/sdk`. */
export type ExecutorRisk = 'read' | 'write' | 'destructive' | string;

/** @deprecated Use `ConnectorAction` from `@kortix/sdk`. */
export interface ExecutorAction {
  path: string;
  name: string;
  description: string;
  risk: ExecutorRisk;
  inputSchema: unknown;
}

/** @deprecated Use `ConnectorCatalogEntry` from `@kortix/sdk`. */
export interface ExecutorConnector {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: ExecutorAction[];
}

/** @deprecated Use `ConnectorTool` from `@kortix/sdk`. */
export interface ExecutorToolMatch {
  tool: string;
  connector: string;
  action: string;
  risk: ExecutorRisk;
  description: string;
  inputSchema: unknown;
}

/** @deprecated Use `ConnectorCallResult` from `@kortix/sdk`. */
export interface ExecutorCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  risk?: ExecutorRisk;
  status?: string;
  reason?: string;
  execution_id?: string | null;
  retryable?: boolean;
  approval_url?: string | null;
  approval_summary?: string | null;
  approval_instructions?: string | null;
}

/** @deprecated Use `ConnectorAttachmentUploadInput` from `@kortix/sdk`. */
export interface ExecutorAttachmentUploadInput extends ConnectorAttachmentUploadInput {}

/** @deprecated Use `ConnectorAttachmentUploadResult` from `@kortix/sdk`. */
export interface ExecutorAttachmentUploadResult extends ConnectorAttachmentUploadResult {}

/** @deprecated Use `createKortix` from `@kortix/sdk`. */
export interface ExecutorClientOptions {
  apiUrl: string;
  token: string;
  /** Canonical Workspace identifier. */
  workspaceId?: string;
  /** @deprecated Use `workspaceId`. */
  projectId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** @deprecated Catch `ApiError` from `@kortix/sdk`. */
export class ExecutorError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ExecutorError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type SDK = ReturnType<typeof createKortix>;

/**
 * Final compatibility adapter for the retired Executor name.
 *
 * @deprecated Use `createKortix({ backendUrl, getToken })` and
 * `kortix.workspace(workspaceId).connectors` from `@kortix/sdk`.
 */
export class ExecutorClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly workspaceId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sdk: SDK;
  private readonly sdkConfig: Parameters<typeof createKortix>[0];

  constructor(opts: ExecutorClientOptions) {
    if (!opts.apiUrl.trim()) throw new Error('apiUrl is required');
    if (!opts.token.trim()) throw new Error('token is required');

    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.workspaceId = opts.workspaceId?.trim() || opts.projectId?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.sdkConfig = {
      backendUrl: this.apiUrl,
      getToken: async () => this.token,
      fetch: this.fetchImpl,
      clientSource: 'cli',
    };
    this.sdk = createKortix(this.sdkConfig);
  }

  private connectorsApi() {
    return this.workspaceId
      ? this.sdk.workspace(this.workspaceId).connectors
      : this.sdk.connectors;
  }

  private async throughSdk<T>(operation: () => Promise<T>): Promise<T> {
    // @kortix/sdk uses one configured client per host. Re-apply this deprecated
    // adapter's configuration before each operation so sequential legacy clients
    // retain their original token and URL behavior during migration.
    configureKortix(this.sdkConfig);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      if (error instanceof ApiError) {
        throw new ExecutorError(
          error.message,
          error.status ?? 0,
          error.details ?? error.data ?? error.detail ?? null,
        );
      }
      throw error;
    }
  }

  async connectors(): Promise<ExecutorConnector[]> {
    return this.throughSdk(async () =>
      (await this.connectorsApi().catalog()) as ExecutorConnector[],
    );
  }

  async tools(): Promise<ExecutorToolMatch[]> {
    return this.throughSdk(async () =>
      (await this.connectorsApi().tools()) as ExecutorToolMatch[],
    );
  }

  async discover(
    query = '',
    opts: { limit?: number } = {},
  ): Promise<ExecutorToolMatch[]> {
    return this.throughSdk(async () =>
      (await this.connectorsApi().search(query, opts)) as ExecutorToolMatch[],
    );
  }

  async describe(tool: string): Promise<ExecutorToolMatch | null> {
    return this.throughSdk(async () =>
      (await this.connectorsApi().describe(tool)) as ExecutorToolMatch | null,
    );
  }

  async call<T = unknown>(
    connector: string,
    action: string,
    args: Record<string, unknown> = {},
    opts: { approvalExecutionId?: string | null } = {},
  ): Promise<ExecutorCallResult<T>> {
    if (opts.approvalExecutionId) {
      const path = this.workspaceId
        ? `/connectors/workspaces/${encodeURIComponent(this.workspaceId)}/call`
        : '/connectors/call';
      return this.request<ExecutorCallResult<T>>(path, {
        method: 'POST',
        body: {
          connector,
          action,
          args,
          approval_execution_id: opts.approvalExecutionId,
        },
      });
    }
    return this.throughSdk(async () =>
      (await this.connectorsApi().call<T>(`${connector}.${action}`, args)) as ExecutorCallResult<T>,
    );
  }

  async uploadAttachment(
    content: Uint8Array | ArrayBuffer | Blob,
    input: ExecutorAttachmentUploadInput,
  ): Promise<ExecutorAttachmentUploadResult> {
    return this.throughSdk(() => this.connectorsApi().uploadAttachment(content, input));
  }

  /**
   * Compatibility-only raw request escape hatch.
   *
   * @deprecated Replace raw Executor routes with the typed Connector methods on
   * `kortix.workspace(workspaceId).connectors` from `@kortix/sdk`.
   */
  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const normalized = normalizeLegacyPath(path);
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET' && normalized === '/connectors/catalog') {
      return { connectors: await this.connectors() } as T;
    }
    if (method === 'POST' && normalized === '/connectors/call') {
      const body = (init.body ?? {}) as {
        connector?: string;
        action?: string;
        args?: Record<string, unknown>;
        approval_execution_id?: string | null;
      };
      return this.call(
        body.connector ?? '',
        body.action ?? '',
        body.args ?? {},
        { approvalExecutionId: body.approval_execution_id },
      ) as Promise<T>;
    }

    const response = await this.fetchImpl(`${this.apiUrl}${normalized}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await response.text();
    const body = parseBody(raw);
    if (!response.ok) {
      throw new ExecutorError(responseMessage(body, response.status), response.status, body);
    }
    return body as T;
  }
}

/**
 * @deprecated Use `createKortix` from `@kortix/sdk`.
 */
export function createExecutorClient(opts: ExecutorClientOptions): ExecutorClient {
  return new ExecutorClient(opts);
}

function normalizeApiUrl(input: string): string {
  let value = input.trim();
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value.endsWith('/v1') ? value : `${value}/v1`;
}

function normalizeLegacyPath(path: string): string {
  let value = path.trim();
  if (value.startsWith('/v1/')) value = value.slice(3);
  if (!value.startsWith('/')) value = `/${value}`;
  if (value === '/executor/connectors' || value === '/executor/catalog') {
    return '/connectors/catalog';
  }
  if (value.startsWith('/executor/')) return `/connectors/${value.slice('/executor/'.length)}`;
  return value;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    for (const key of ['reason', 'error', 'message', 'detail']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
  }
  return `HTTP ${status}`;
}
