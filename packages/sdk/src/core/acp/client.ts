import { authenticatedFetch } from '../http/auth';
import {
  type AcpContentBlock,
  type AcpEnvelope,
  type AcpJsonRpcId,
  type AcpResponse,
  AcpRpcError,
  type AcpStreamEvent,
  type AcpStreamHandle,
  type AcpTranscript,
  AcpTransportError,
} from './types';

export { AcpRpcError, AcpTransportError } from './types';

export interface AcpClientOptions {
  endpoint: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponse(value: AcpEnvelope | null): value is AcpResponse {
  return !!value && 'id' in value && ('result' in value || 'error' in value);
}

function isTerminalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function parseEventBlock(block: string): AcpStreamEvent | null {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!Number.isSafeInteger(id) || id === null || data.length === 0) return null;
  const envelope = JSON.parse(data.join('\n')) as AcpEnvelope;
  return { id, envelope };
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AcpStreamEvent) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
    const blocks = pending.split('\n\n');
    pending = blocks.pop() ?? '';
    if (done && pending.trim()) blocks.push(pending);
    for (const block of blocks) {
      try {
        const event = parseEventBlock(block);
        if (event) onEvent(event);
      } catch (error) {
        onError(error);
      }
    }
    if (done) return;
  }
}

export class AcpClient {
  private static instanceCount = 0;
  private readonly idPrefix = `${Date.now()}-${AcpClient.instanceCount++}`;
  private nextId = 0;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: AcpClientOptions) {
    this.endpoint = trimTrailingSlashes(options.endpoint);
    this.fetcher = options.fetch ?? (authenticatedFetch as typeof fetch);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.requestWithTimeout<T>(method, params, this.requestTimeoutMs);
  }

  private async requestWithTimeout<T>(
    method: string,
    params: unknown,
    timeoutMs: number | null,
  ): Promise<T> {
    const id = `${this.idPrefix}-${++this.nextId}`;
    const key = JSON.stringify(id);
    const result = new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`Timed out waiting for ACP response to ${method}`));
            }, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    try {
      const response = await this.post({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      if (response) {
        if (!isResponse(response)) {
          throw new Error(`ACP method ${method} returned an invalid response`);
        }
        this.settleResponse(response);
      }
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async respond(id: AcpJsonRpcId, result?: unknown, error?: AcpResponse['error']): Promise<void> {
    await this.post({
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null }),
    });
  }

  initialize() {
    return this.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: '@kortix/sdk', version: '0.3.0' },
    });
  }

  newSession(input: { cwd: string; mcpServers?: unknown[] }) {
    return this.request<{ sessionId: string } & Record<string, unknown>>('session/new', {
      ...input,
      mcpServers: input.mcpServers ?? [],
    });
  }

  loadSession(input: { sessionId: string; cwd: string; mcpServers?: unknown[] }) {
    return this.request<Record<string, unknown>>('session/load', {
      ...input,
      mcpServers: input.mcpServers ?? [],
    });
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]) {
    return this.requestWithTimeout<{
      stopReason: string;
      usage?: Record<string, unknown>;
    }>('session/prompt', { sessionId, prompt }, null);
  }

  cancel(sessionId: string) {
    return this.notify('session/cancel', { sessionId });
  }

  revertSession(sessionId: string, messageId: string) {
    return this.request<Record<string, unknown>>('session/revert', {
      sessionId,
      messageId,
    });
  }

  unrevertSession(sessionId: string) {
    return this.request<Record<string, unknown>>('session/unrevert', {
      sessionId,
    });
  }

  setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
    return this.request<Record<string, unknown>>('session/set_config_option', {
      sessionId,
      configId,
      value,
    });
  }

  async transcript(after?: number): Promise<AcpTranscript> {
    const response = await this.fetcher(
      `${this.endpoint}/transcript${after ? `?after=${after}` : ''}`,
    );
    if (!response.ok) {
      throw new AcpTransportError(
        `ACP transcript failed with HTTP ${response.status}`,
        response.status,
        isTerminalStatus(response.status),
      );
    }
    return response.json() as Promise<AcpTranscript>;
  }

  connect(options: {
    onEvent(event: AcpStreamEvent): void;
    onError?(error: unknown): void;
    lastEventId?: number;
    reconnect?: boolean;
    signal?: AbortSignal;
  }): AcpStreamHandle {
    let lastEventId = options.lastEventId ?? 0;
    let hasEventId = options.lastEventId !== undefined;
    let closed = false;
    const controller = new AbortController();
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    let opened = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const run = async () => {
      let retryMs = 250;
      while (!closed && !controller.signal.aborted) {
        try {
          const response = await this.fetcher(this.endpoint, {
            headers: {
              Accept: 'text/event-stream',
              ...(hasEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
            },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new AcpTransportError(
              `ACP stream failed with HTTP ${response.status}`,
              response.status,
              isTerminalStatus(response.status),
            );
          }
          if (!response.body) throw new Error('ACP stream response has no body');
          await consumeSse(
            response.body,
            (event) => {
              if (!opened) {
                opened = true;
                resolveReady();
              }
              if (hasEventId && event.id <= lastEventId) return;
              hasEventId = true;
              lastEventId = event.id;
              retryMs = 250;
              if (isResponse(event.envelope)) {
                this.settleResponse(event.envelope);
              }
              options.onEvent(event);
            },
            (error) => options.onError?.(error),
          );
          if (options.reconnect === false) return;
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          options.onError?.(error);
          if (
            options.reconnect === false ||
            (error instanceof AcpTransportError && error.terminal)
          ) {
            if (!opened) {
              rejectReady(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    };
    queueMicrotask(() => void run());

    return {
      close() {
        if (closed) return;
        closed = true;
        options.signal?.removeEventListener('abort', onAbort);
        controller.abort();
        if (!opened) rejectReady(new Error('ACP stream closed before opening'));
      },
      get lastEventId() {
        return lastEventId;
      },
      ready,
    };
  }

  private async post(envelope: AcpEnvelope): Promise<AcpEnvelope | null> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (response.status === 202 || response.status === 204) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AcpTransportError(
        `ACP request failed with HTTP ${response.status}: ${text}`,
        response.status,
        isTerminalStatus(response.status),
      );
    }
    const value = (await response.json()) as unknown;
    if (!isObject(value) || value.jsonrpc !== '2.0') {
      throw new Error('ACP response is not a JSON-RPC 2.0 envelope');
    }
    return value as AcpEnvelope;
  }

  private settleResponse(response: AcpResponse): void {
    const key = JSON.stringify(response.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(key);
    if (response.error) {
      pending.reject(
        new AcpRpcError(response.error.message, response.error.code, response.error.data),
      );
      return;
    }
    pending.resolve(response.result);
  }
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  return new AcpClient(options);
}
