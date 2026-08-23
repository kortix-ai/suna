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
  readonly desktop: DesktopNamespace;

  constructor(config: TunnelClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.explicitTunnelId = config.tunnelId;
    this.cacheTtlMs = config.cacheTtlMs ?? 10_000;

    this.fs = new FsNamespace(this);
    this.shell = new ShellNamespace(this);
    this.desktop = new DesktopNamespace(this);
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

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        throw new TunnelClientError(-1, `HTTP ${res.status} ${res.statusText}`, undefined, false);
      }
      throw new Error(`Failed to parse response for ${method}: unexpected non-JSON body`);
    }

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

    try {
      return (await res.json()) as Array<Record<string, unknown>>;
    } catch {
      throw new Error(`Failed to parse connections response: unexpected non-JSON body`);
    }
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
      if (online) {
        this.cachedTunnelId = online.tunnelId;
        this.cacheTimestamp = Date.now();
        return online.tunnelId;
      }
      if (connections.length > 0) {
        this.cachedTunnelId = connections[0].tunnelId;
        this.cacheTimestamp = Date.now();
        return connections[0].tunnelId;
      }
    }

    this.cachedTunnelId = null;
    throw new TunnelClientError(
      -1,
      'No tunnel connection found. The user needs to set up Agent Tunnel first:\n' +
      '1. Create a tunnel connection\n' +
      '2. Run `npx @kortix/agent-tunnel connect` on their local machine',
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

class DesktopNamespace {
  constructor(private client: TunnelClient) {}

  async screenshot(params?: { region?: { x: number; y: number; width: number; height: number }; windowId?: number }): Promise<{ image: string; width: number; height: number; format?: string }> {
    return (await this.client.rpc('desktop.screenshot', params ?? {})) as any;
  }

  async click(params: { x: number; y: number; button?: string; clicks?: number; modifiers?: string[] }): Promise<unknown> {
    return this.client.rpc('desktop.mouse.click', params);
  }

  async type(text: string, delay?: number): Promise<unknown> {
    return this.client.rpc('desktop.keyboard.type', { text, delay });
  }

  async key(keys: string[]): Promise<unknown> {
    return this.client.rpc('desktop.keyboard.key', { keys });
  }

  async mouseMove(x: number, y: number): Promise<unknown> {
    return this.client.rpc('desktop.mouse.move', { x, y });
  }

  async mouseDrag(fromX: number, fromY: number, toX: number, toY: number, button?: string): Promise<unknown> {
    return this.client.rpc('desktop.mouse.drag', { fromX, fromY, toX, toY, button });
  }

  async mouseScroll(x: number, y: number, deltaX?: number, deltaY?: number): Promise<unknown> {
    return this.client.rpc('desktop.mouse.scroll', { x, y, deltaX, deltaY });
  }

  async windowList(): Promise<{ windows: Array<{ id: number; app: string; title: string; bounds: { x: number; y: number; width: number; height: number }; minimized: boolean }> }> {
    return (await this.client.rpc('desktop.window.list', {})) as any;
  }

  async windowFocus(windowId: number): Promise<unknown> {
    return this.client.rpc('desktop.window.focus', { windowId });
  }

  async appLaunch(app: string): Promise<unknown> {
    return this.client.rpc('desktop.app.launch', { app });
  }

  async appQuit(app: string): Promise<unknown> {
    return this.client.rpc('desktop.app.quit', { app });
  }

  async clipboardRead(): Promise<{ text: string }> {
    return (await this.client.rpc('desktop.clipboard.read', {})) as any;
  }

  async clipboardWrite(text: string): Promise<unknown> {
    return this.client.rpc('desktop.clipboard.write', { text });
  }

  async screenInfo(): Promise<{ width: number; height: number; scaleFactor: number }> {
    return (await this.client.rpc('desktop.screen.info', {})) as any;
  }

  async cursorImage(radius?: number): Promise<{ image: string; width: number; height: number; format?: string }> {
    return (await this.client.rpc('desktop.cursor.image', { radius })) as any;
  }

  async axTree(params?: { pid?: number; maxDepth?: number; roles?: string[] }): Promise<{ root: AXElement; elementCount: number }> {
    return (await this.client.rpc('desktop.ax.tree', params ?? {})) as any;
  }

  async axAction(elementId: string, action: string, pid?: number): Promise<Record<string, unknown>> {
    return (await this.client.rpc('desktop.ax.action', { elementId, action, pid })) as any;
  }

  async axSetValue(elementId: string, value: string, pid?: number): Promise<Record<string, unknown>> {
    return (await this.client.rpc('desktop.ax.set_value', { elementId, value, pid })) as any;
  }

  async axFocus(elementId: string, pid?: number): Promise<Record<string, unknown>> {
    return (await this.client.rpc('desktop.ax.focus', { elementId, pid })) as any;
  }

  async axSearch(query: string, params?: { role?: string; pid?: number; maxResults?: number }): Promise<{ elements: AXElement[] }> {
    return (await this.client.rpc('desktop.ax.search', { query, ...params })) as any;
  }
}

export interface AXElement {
  id: string;
  role: string;
  title: string;
  value: string;
  description: string;
  bounds: { x: number; y: number; width: number; height: number };
  children: AXElement[];
  actions: string[];
  enabled: boolean;
  focused: boolean;
}
