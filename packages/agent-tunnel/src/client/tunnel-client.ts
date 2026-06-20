export interface TunnelClientConfig {
  apiUrl: string;
  token: string;
  tunnelId?: string;
  cacheTtlMs?: number;
}

export class TunnelClientError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly requestId?: string,
    public readonly isPermissionRequest = false,
  ) {
    super(message);
    this.name = 'TunnelClientError';
  }
}

export class TunnelClient {
  private apiUrl: string;
  private token: string;
  private explicitTunnelId: string | undefined;
  private cachedTunnelId: string | null = null;
  private cacheTimestamp = 0;
  private cacheTtlMs: number;

  readonly fs: FsNamespace;
  readonly shell: ShellNamespace;
  readonly cua: CuaNamespace;

  constructor(config: TunnelClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.explicitTunnelId = config.tunnelId;
    this.cacheTtlMs = config.cacheTtlMs ?? 10_000;

    this.fs = new FsNamespace(this);
    this.shell = new ShellNamespace(this);
    this.cua = new CuaNamespace(this);
  }

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const tunnelId = await this.resolveTunnelId();

    const res = await fetch(`${this.apiUrl}/rpc/${tunnelId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ method, params }),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      if (res.status === 404) this.cachedTunnelId = null;

      throw new TunnelClientError(
        (data.code as number) ?? -1,
        (data.error as string) ?? `HTTP ${res.status}`,
        data.requestId as string | undefined,
        res.status === 403 && !!data.requestId,
      );
    }

    return data.result;
  }

  async rpcWithPermissionFlow(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.rpc(method, params);
    } catch (err) {
      if (err instanceof TunnelClientError && err.isPermissionRequest) {
        return `Permission required. A permission request (${err.requestId}) has been sent to the user for approval. The user needs to approve this request before you can access their local machine. Please inform the user and try again after they approve.`;
      }
      throw err;
    }
  }

  async getConnections(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${this.apiUrl}/connections`, {
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });

    if (!res.ok) {
      throw new TunnelClientError(-1, `Failed to list connections: HTTP ${res.status}`);
    }

    return (await res.json()) as Array<Record<string, unknown>>;
  }

  async resolveTunnelId(): Promise<string> {
    if (this.explicitTunnelId) return this.explicitTunnelId;

    if (this.cachedTunnelId && (Date.now() - this.cacheTimestamp) < this.cacheTtlMs) {
      return this.cachedTunnelId;
    }

    const res = await fetch(`${this.apiUrl}/connections`, {
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });

    if (res.ok) {
      const connections = (await res.json()) as Array<{ tunnelId: string; isLive?: boolean }>;
      const online = connections.find((c) => c.isLive);
      const chosen = online ?? connections[0];
      if (chosen) {
        this.cachedTunnelId = chosen.tunnelId;
        this.cacheTimestamp = Date.now();
        return chosen.tunnelId;
      }
    }

    this.cachedTunnelId = null;
    throw new TunnelClientError(
      -1,
      'No tunnel connection found. The user needs to set up Agent Tunnel first:\n' +
      '1. Create a tunnel connection\n' +
      '2. Connect the local machine from the Kortix desktop app or run the tunnel connect command',
    );
  }
}

class FsNamespace {
  constructor(private client: TunnelClient) {}

  async read(path: string, encoding = 'utf-8'): Promise<{ content: string; size: number; path: string }> {
    return (await this.client.rpc('fs.read', { path, encoding })) as any;
  }

  async write(path: string, content: string, encoding = 'utf-8'): Promise<{ path: string; size: number }> {
    return (await this.client.rpc('fs.write', { path, content, encoding })) as any;
  }

  async list(path: string, recursive = false): Promise<{ entries: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }>; count: number }> {
    return (await this.client.rpc('fs.list', { path, recursive })) as any;
  }

  async stat(path: string): Promise<Record<string, unknown>> {
    return (await this.client.rpc('fs.stat', { path })) as any;
  }

  async delete(path: string): Promise<Record<string, unknown>> {
    return (await this.client.rpc('fs.delete', { path })) as any;
  }
}

class ShellNamespace {
  constructor(private client: TunnelClient) {}

  async exec(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    return (await this.client.rpc('shell.exec', {
      command,
      args,
      cwd: options?.cwd,
      timeout: options?.timeout,
    })) as any;
  }
}

class CuaNamespace {
  constructor(private client: TunnelClient) {}

  async ensure(): Promise<{ ok: boolean; binary: string; version?: string }> {
    return (await this.client.rpc('desktop.cua.ensure', {})) as any;
  }

  async startDaemon(): Promise<Record<string, unknown>> {
    return (await this.client.rpc('desktop.cua.start_daemon', {})) as any;
  }

  async status(): Promise<{ status: string }> {
    return (await this.client.rpc('desktop.cua.status', {})) as any;
  }

  async version(): Promise<{ version: string }> {
    return (await this.client.rpc('desktop.cua.version', {})) as any;
  }

  async listTools(): Promise<{ tools: string }> {
    return (await this.client.rpc('desktop.cua.list_tools', {})) as any;
  }

  async describe(tool: string): Promise<{ description: string }> {
    return (await this.client.rpc('desktop.cua.describe', { tool })) as any;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.client.rpc('desktop.cua.call', { tool, args });
  }

  async listApps(): Promise<unknown> {
    return this.client.rpc('desktop.cua.list_apps', {});
  }

  async listWindows(params?: { pid?: number; on_screen_only?: boolean }): Promise<unknown> {
    return this.client.rpc('desktop.cua.list_windows', params ?? {});
  }

  async getWindowState(params: { pid: number; window_id: number; query?: string; capture_mode?: 'som' | 'vision' | 'ax'; screenshot_out_file?: string; session?: string }): Promise<unknown> {
    return this.client.rpc('desktop.cua.get_window_state', params);
  }

  async click(params: Record<string, unknown>): Promise<unknown> {
    return this.client.rpc('desktop.cua.click', params);
  }

  async typeText(params: Record<string, unknown>): Promise<unknown> {
    return this.client.rpc('desktop.cua.type_text', params);
  }

  async hotkey(params: Record<string, unknown>): Promise<unknown> {
    return this.client.rpc('desktop.cua.hotkey', params);
  }
}
