export type ConnectorRisk = 'read' | 'write' | 'destructive' | string;

export interface ConnectorAction {
  path: string;
  name: string;
  description: string;
  risk: ConnectorRisk;
  inputSchema: unknown;
}

export interface ConnectorDefinition {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: ConnectorAction[];
}

export interface ConnectorToolMatch {
  tool: string;
  connector: string;
  action: string;
  risk: ConnectorRisk;
  description: string;
  inputSchema: unknown;
}

export interface ConnectorCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  risk?: ConnectorRisk;
  status?: string;
  reason?: string;
  /** For a `pending_approval` result: the execution awaiting a human decision. */
  execution_id?: string | null;
  /** Always false on callback-based approval handoffs. */
  retryable?: boolean;
  /** Authenticated page a human opens to approve or deny this one call. */
  approval_url?: string | null;
  /** Redacted one-line description safe to relay with the URL. */
  approval_summary?: string | null;
  /** Agent instruction for the asynchronous approval handoff. */
  approval_instructions?: string | null;
}

export interface ConnectorAttachmentUploadInput {
  filename: string;
  contentType: string;
  contentDisposition?: 'attachment' | 'inline';
  contentId?: string;
}

export interface ConnectorAttachmentUploadResult {
  attachment_id: string;
  filename: string;
  content_type: string;
  content_disposition: 'attachment' | 'inline';
  content_id?: string;
  size: number;
  expires_at: string;
}

export interface ConnectorClientOptions {
  apiUrl: string;
  token: string;
  /**
   * Project to operate against. When set, calls hit the project-explicit gateway
   * routes (`/connectors/projects/:projectId/{catalog,call}`), which accept ANY
   * valid principal — a logged-in user token OR an in-sandbox session token.
   * This is what makes the Connector usable identically on a laptop and inside a
   * sandbox. When omitted, falls back to the legacy flat routes
   * (`/connectors/{connectors,call}`), which derive the project from a scoped
   * session token (back-compat for already-baked sandboxes).
   */
  projectId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export class ConnectorClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly projectId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ConnectorClientOptions) {
    if (!opts.apiUrl.trim()) throw new Error('apiUrl is required');
    if (!opts.token.trim()) throw new Error('token is required');
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.projectId = opts.projectId?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Catalog endpoint — project-explicit when a projectId is set, else session-scoped. */
  private catalogPath(): string {
    return this.projectId
      ? `/connectors/projects/${encodeURIComponent(this.projectId)}/catalog`
      : '/connectors/catalog';
  }

  /** Call endpoint — project-explicit when a projectId is set, else legacy flat. */
  private callPath(): string {
    return this.projectId
      ? `/connectors/projects/${encodeURIComponent(this.projectId)}/call`
      : '/connectors/call';
  }

  /** Raw-byte upload endpoint — project-explicit when a projectId is set. */
  private attachmentPath(): string {
    return this.projectId
      ? `/connectors/projects/${encodeURIComponent(this.projectId)}/attachments`
      : '/connectors/attachments';
  }

  async connectors(): Promise<ConnectorDefinition[]> {
    const body = await this.request<{ connectors?: ConnectorDefinition[] } | null>(
      this.catalogPath(),
    );
    return body?.connectors ?? [];
  }

  async tools(): Promise<ConnectorToolMatch[]> {
    return flattenCatalog(await this.connectors());
  }

  async discover(query = '', opts: { limit?: number } = {}): Promise<ConnectorToolMatch[]> {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const exactMatches: ConnectorToolMatch[] = [];
    const tokenMatches: ConnectorToolMatch[] = [];
    for (const tool of await this.tools()) {
      const haystack = `${tool.tool} ${tool.description}`.toLowerCase();
      if (!q || haystack.includes(q)) exactMatches.push(tool);
      else if (tokens.every((token) => haystack.includes(token))) tokenMatches.push(tool);
    }
    return [...exactMatches, ...tokenMatches].slice(0, opts.limit ?? 20);
  }

  async describe(tool: string): Promise<ConnectorToolMatch | null> {
    return (await this.tools()).find((candidate) => candidate.tool === tool) ?? null;
  }

  async call<T = unknown>(
    connector: string,
    action: string,
    args: Record<string, unknown> = {},
    opts: { approvalExecutionId?: string | null } = {},
  ): Promise<ConnectorCallResult<T>> {
    return this.request<ConnectorCallResult<T>>(this.callPath(), {
      method: 'POST',
      body: {
        connector,
        action,
        args,
        // Kept for compatibility with older clients. The gateway does not poll it.
        ...(opts.approvalExecutionId ? { approval_execution_id: opts.approvalExecutionId } : {}),
      },
    });
  }

  async uploadAttachment(
    content: Uint8Array | ArrayBuffer | Blob,
    input: ConnectorAttachmentUploadInput,
  ): Promise<ConnectorAttachmentUploadResult> {
    const filename = input.filename.trim();
    const contentType = input.contentType.trim();
    if (!filename) throw new Error('filename is required');
    if (!contentType) throw new Error('contentType is required');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': contentType,
      'X-Kortix-Attachment-Filename': encodeURIComponent(filename),
      'X-Kortix-Attachment-Disposition': input.contentDisposition ?? 'attachment',
    };
    if (input.contentId?.trim()) {
      headers['X-Kortix-Attachment-Content-Id'] = encodeURIComponent(input.contentId.trim());
    }
    const res = await this.fetchImpl(buildUrl(this.apiUrl, this.attachmentPath()), {
      method: 'POST',
      headers,
      body: content as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse<ConnectorAttachmentUploadResult>(res);
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchImpl(buildUrl(this.apiUrl, path), {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const body = parseBody(text);
    if (!res.ok) {
      const message =
        body && typeof body === 'object'
          ? String(
              (body as { reason?: unknown; error?: unknown; message?: unknown }).reason ??
                (body as { error?: unknown }).error ??
                (body as { message?: unknown }).message ??
                `HTTP ${res.status}`,
            )
          : `HTTP ${res.status}`;
      throw new ConnectorError(message, res.status, body);
    }
    return body as T;
  }
}

export function createConnectorClient(opts: ConnectorClientOptions): ConnectorClient {
  return new ConnectorClient(opts);
}

function flattenCatalog(connectors: ConnectorDefinition[]): ConnectorToolMatch[] {
  const tools: ConnectorToolMatch[] = [];
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
  let trimmed = input.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildUrl(apiUrl: string, path: string): string {
  const suffix = path.startsWith('/v1/') ? path.slice(3) : path.startsWith('/') ? path : `/${path}`;
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
