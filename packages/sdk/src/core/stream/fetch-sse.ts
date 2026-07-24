/**
 * Fetch-based SSE client with header-based authentication.
 */

export interface SSEStreamOptions {
  url: string;
  token: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  onEvent?: (event: string, data: string) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export interface SSEStream {
  connect: () => void;
  close: () => void;
  addEventListener: (event: string, handler: (data: string) => void) => void;
  removeEventListener: (event: string, handler: (data: string) => void) => void;
}

export function buildTunnelEventStreamUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/tunnel/permission-requests/stream`;
}

export function createSSEStream(options: SSEStreamOptions): SSEStream {
  const {
    url,
    token,
    method = 'GET',
    body,
    onEvent,
    onOpen,
    onError,
    signal: externalSignal,
  } = options;

  const listeners = new Map<string, Set<(data: string) => void>>();
  let abortController: AbortController | null = null;
  let closed = false;

  function emit(event: string, data: string) {
    onEvent?.(event, data);
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch {
        // Listener failures do not terminate the stream.
      }
    }
  }

  async function connect() {
    if (closed) return;
    abortController = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([abortController.signal, externalSignal])
      : abortController.signal;

    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      };
      if (method !== 'GET' && body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' && body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }
      if (!response.body) throw new Error('SSE response has no body');
      onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      let currentData = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line === '') {
            if (currentData) {
              emit(currentEvent, currentData.trimEnd());
              currentEvent = 'message';
              currentData = '';
            }
          } else if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData += (currentData ? '\n' : '') + line.slice(6);
          } else if (line.startsWith('data:')) {
            currentData += (currentData ? '\n' : '') + line.slice(5);
          }
        }
      }
    } catch (cause) {
      if (closed) return;
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  function close() {
    closed = true;
    abortController?.abort();
    abortController = null;
    listeners.clear();
  }

  function addEventListener(event: string, handler: (data: string) => void) {
    const handlers = listeners.get(event) ?? new Set();
    handlers.add(handler);
    listeners.set(event, handlers);
  }

  function removeEventListener(event: string, handler: (data: string) => void) {
    listeners.get(event)?.delete(handler);
  }

  return { connect, close, addEventListener, removeEventListener };
}

export function createTunnelEventStream(
  apiUrl: string,
  options: Omit<SSEStreamOptions, 'url'>,
): SSEStream {
  return createSSEStream({
    ...options,
    url: buildTunnelEventStreamUrl(apiUrl),
  });
}
