/**
 * Fetch-based SSE client that supports Authorization headers.
 *
 * Unlike native EventSource, this uses `fetch()` + ReadableStream, which
 * allows setting custom headers (Authorization: Bearer). This eliminates
 * the need to pass tokens via query parameters.
 *
 * Usage:
 *   const sse = createSSEStream(url, token);
 *   sse.addEventListener('event_name', (data) => { ... });
 *   sse.connect();
 *   // later:
 *   sse.close();
 */

export interface SSEStreamOptions {
  /** The SSE endpoint URL (no token query params needed) */
  url: string;
  /** Bearer token for Authorization header */
  token: string;
  /** Called when a named SSE event is received */
  onEvent?: (event: string, data: string) => void;
  /** Called when the connection is established */
  onOpen?: () => void;
  /** Called when an error occurs or the connection drops */
  onError?: (error: Error) => void;
  /** AbortSignal to cancel the stream */
  signal?: AbortSignal;
}

export interface SSEStream {
  /** Start the SSE connection */
  connect: () => void;
  /** Close the SSE connection */
  close: () => void;
  /** Register a named event listener */
  addEventListener: (event: string, handler: (data: string) => void) => void;
  /** Remove a named event listener */
  removeEventListener: (event: string, handler: (data: string) => void) => void;
}

/**
 * Create a fetch-based SSE stream with header-based auth.
 */
export function createSSEStream(options: SSEStreamOptions): SSEStream {
  const { url, token, onEvent, onOpen, onError, signal: externalSignal } = options;

  const listeners = new Map<string, Set<(data: string) => void>>();
  let abortController: AbortController | null = null;
  let closed = false;

  function emit(event: string, data: string) {
    onEvent?.(event, data);
    const handlers = listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch {
          // Swallow listener errors
        }
      }
    }
  }

  async function connect() {
    if (closed) return;

    abortController = new AbortController();
    const combinedSignal = externalSignal
      ? AbortSignal.any([abortController.signal, externalSignal])
      : abortController.signal;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        signal: combinedSignal,
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

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

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line === '') {
            // Empty line = end of event
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
          } else if (line.startsWith(':')) {
            // Comment (keep-alive) — ignore
          }
        }
      }
    } catch (err) {
      if (closed) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function close() {
    closed = true;
    abortController?.abort();
    abortController = null;
    listeners.clear();
  }

  function addEventListener(event: string, handler: (data: string) => void) {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler);
  }

  function removeEventListener(event: string, handler: (data: string) => void) {
    listeners.get(event)?.delete(handler);
  }

  return { connect, close, addEventListener, removeEventListener };
}
