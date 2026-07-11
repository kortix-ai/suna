import { authenticatedFetch } from '../platform/auth';
import type {
  AcpContentBlock,
  AcpEnvelope,
  AcpJsonRpcId,
  AcpResponse,
  AcpStreamEvent,
  AcpStreamHandle,
} from './types';
import { AcpRpcError } from './types';

export type AcpClientOptions = {
  /** Exact session-scoped ACP endpoint. Preferred for provider-neutral clients. */
  endpoint?: string;
  /** Direct daemon bridge inputs (low-level/testing compatibility). */
  baseUrl?: string;
  serverId?: string;
  fetch?: typeof fetch;
};

function isResponse(value: AcpEnvelope): value is AcpResponse {
  return 'id' in value && ('result' in value || 'error' in value) && !('method' in value);
}

export class AcpClient {
  private nextId = 1;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;

  constructor(readonly options: AcpClientOptions) {
    this.fetcher = options.fetch ?? (authenticatedFetch as typeof fetch);
    if (options.endpoint) this.endpoint = options.endpoint.replace(/\/$/, '');
    else if (options.baseUrl && options.serverId) {
      this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/acp/${encodeURIComponent(options.serverId)}`;
    } else {
      throw new Error('AcpClient requires endpoint, or baseUrl + serverId');
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const envelope = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    if (!envelope || !isResponse(envelope)) throw new Error(`ACP method ${method} returned no JSON-RPC response`);
    if (envelope.error) throw new AcpRpcError(envelope.error.message, envelope.error.code, envelope.error.data);
    return envelope.result as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: AcpJsonRpcId, result?: unknown, error?: AcpResponse['error']): Promise<void> {
    await this.post({ jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? null }) });
  }

  initialize(params: {
    protocolVersion: number;
    clientCapabilities?: Record<string, unknown>;
    clientInfo?: { name: string; title?: string; version: string };
  }) {
    return this.request<Record<string, unknown>>('initialize', params);
  }

  newSession(params: { cwd: string; mcpServers?: unknown[] }) {
    return this.request<{ sessionId: string }>('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
  }

  loadSession(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }) {
    return this.request<Record<string, unknown>>('session/load', {
      ...params,
      mcpServers: params.mcpServers ?? [],
    });
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]) {
    return this.request<{ stopReason: string }>('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string) {
    return this.notify('session/cancel', { sessionId });
  }

  async transcript(after?: number): Promise<{
    runtime_id: string;
    envelopes: Array<{
      ordinal: number;
      direction: 'client_to_agent' | 'agent_to_client';
      streamEventId: number | null;
      envelope: AcpEnvelope;
      createdAt: string;
    }>;
  }> {
    const url = `${this.endpoint}/transcript${after ? `?after=${after}` : ''}`;
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`ACP transcript failed with HTTP ${response.status}`);
    return response.json();
  }

  connect(options: {
    onEvent(event: AcpStreamEvent): void;
    onError?(error: unknown): void;
    lastEventId?: number;
    signal?: AbortSignal;
    reconnect?: boolean;
  }): AcpStreamHandle {
    const controller = new AbortController();
    let lastEventId = options.lastEventId ?? 0;
    let closed = false;
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const run = async () => {
      let retryMs = 250;
      while (!closed && !controller.signal.aborted) {
        try {
          const response = await this.fetcher(this.endpoint, {
            headers: {
              Accept: 'text/event-stream',
              ...(lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {}),
            },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`ACP stream failed with HTTP ${response.status}`);
          retryMs = 250;
          await consumeSse(response.body, (event) => {
            if (event.id <= lastEventId) return;
            lastEventId = event.id;
            options.onEvent(event);
          });
          if (options.reconnect === false) return;
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          options.onError?.(error);
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    };
    void run();

    return {
      close() {
        closed = true;
        controller.abort();
      },
      get lastEventId() {
        return lastEventId;
      },
    };
  }

  private async post(envelope: AcpEnvelope): Promise<AcpEnvelope | null> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (response.status === 202 || response.status === 204) return null;
    if (!response.ok) throw new Error(`ACP request failed with HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as AcpEnvelope;
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  emit: (event: AcpStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    // A finite test/server response may close immediately after the final
    // event's terminating newline instead of sending another blank line.
    if (done && buffer.trim()) buffer += '\n\n';
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/g, '');
      buffer = buffer.slice(boundary + 2);
      let id: number | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (id !== null && Number.isSafeInteger(id) && data.length) {
        emit({ id, envelope: JSON.parse(data.join('\n')) as AcpEnvelope });
      }
    }
    if (done) return;
  }
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  return new AcpClient(options);
}
