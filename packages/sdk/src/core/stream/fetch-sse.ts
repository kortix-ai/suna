/**
 * Fetch-based SSE client with header-based authentication.
 */

import { retiredEndpointError } from '../http/api/errors';

export interface SSEStreamOptions {
  url: string;
  token: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  onEvent?: (event: string, data: string) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  /** The server ended the stream cleanly. Not called on `close()` or an error. */
  onClose?: () => void;
  signal?: AbortSignal;
}

export interface SSEStream {
  connect: () => void;
  close: () => void;
  addEventListener: (event: string, handler: (data: string) => void) => void;
  removeEventListener: (event: string, handler: (data: string) => void) => void;
}

/**
 * @deprecated The API deleted `/tunnel/permission-requests/stream` with tunnel
 * permission requests. Always throws `ENDPOINT_RETIRED`. Removed in the next major.
 */
export function buildTunnelEventStreamUrl(_apiUrl: string): string {
  throw retiredEndpointError('buildTunnelEventStreamUrl');
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
    onClose,
    signal: externalSignal,
  } = options;

  const listeners = new Map<string, Set<(data: string) => void>>();
  let abortController: AbortController | null = null;
  let closed = false;
  let lastEventId = '';

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
    const attempt = new AbortController();
    abortController = attempt;
    // `AbortSignal.any` is missing on React Native and older Safari. Link by hand.
    if (externalSignal) {
      if (externalSignal.aborted) attempt.abort();
      else externalSignal.addEventListener('abort', () => attempt.abort(), { once: true });
    }
    const signal = attempt.signal;

    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      };
      if (method !== 'GET' && body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
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
      let dataLines: string[] = [];

      const processLine = (line: string) => {
        if (line === '') {
          // An event with no `data:` dispatches nothing but still ends the frame.
          if (dataLines.length > 0) emit(currentEvent, dataLines.join('\n'));
          currentEvent = 'message';
          dataLines = [];
          return;
        }
        if (line.startsWith(':')) return; // comment
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') currentEvent = value.trim() || 'message';
        else if (field === 'data') dataLines.push(value);
        else if (field === 'id' && !value.includes('\0')) lastEventId = value;
      };
      // Lines end in CRLF, LF or a lone CR. A chunk may end between CR and LF:
      // hold a trailing CR back until the next chunk shows whether an LF follows.
      const consume = (final: boolean) => {
        let held = '';
        if (!final && buffer.endsWith('\r')) {
          held = '\r';
          buffer = buffer.slice(0, -1);
        }
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = (lines.pop() ?? '') + held;
        for (const line of lines) processLine(line);
      };

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consume(false);
      }
      if (!closed) {
        buffer += decoder.decode();
        consume(true);
        // A frame cut off at end of stream is incomplete: the spec discards it.
        onClose?.();
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

/**
 * @deprecated The API deleted `/tunnel/permission-requests/stream` with tunnel
 * permission requests. Always throws `ENDPOINT_RETIRED`. Removed in the next major.
 */
export function createTunnelEventStream(
  _apiUrl: string,
  _options: Omit<SSEStreamOptions, 'url'>,
): SSEStream {
  throw retiredEndpointError('createTunnelEventStream');
}
