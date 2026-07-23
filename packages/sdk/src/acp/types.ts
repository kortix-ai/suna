export type AcpJsonRpcId = string | number;

export type AcpRequest = {
  jsonrpc: '2.0';
  id: AcpJsonRpcId;
  method: string;
  params?: unknown;
};

export type AcpNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type AcpResponse = {
  jsonrpc: '2.0';
  id: AcpJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type AcpEnvelope = AcpRequest | AcpNotification | AcpResponse;

export type AcpContentBlock =
  | { type: 'text'; text: string; annotations?: Record<string, unknown> }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: Record<string, unknown> }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string };

export type AcpStreamEvent = {
  id: number;
  envelope: AcpEnvelope;
};

export type AcpStreamHandle = {
  close(): void;
  readonly lastEventId: number;
};

export type AcpInitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<Record<string, unknown>>;
  agentInfo?: { name?: string; title?: string; version?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type AcpSessionConfigOption = {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type AcpSessionResult = {
  sessionId?: string;
  configOptions?: AcpSessionConfigOption[];
  [key: string]: unknown;
};
export type AcpNewSessionResult = AcpSessionResult & { sessionId: string };

export class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

/**
 * Non-2xx HTTP response from the ACP transport (POST request/notify/respond,
 * the SSE `connect()` loop, or the `transcript()` poll fetch) — distinct from
 * `AcpRpcError`, which is a JSON-RPC-level `error` field on an otherwise-
 * successful HTTP response.
 *
 * `terminal` marks statuses where retrying is pointless (4xx client errors),
 * except `408 Request Timeout` and `429 Too Many Requests`, which are
 * transient-by-convention and should keep retrying with backoff.
 */
export class AcpTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = 'AcpTransportError';
  }
}

/**
 * Lifecycle of the live ACP transport (`AcpClient.connect()`'s SSE loop or
 * transcript-poll fallback), surfaced via `connect()`'s `onState` callback
 * and mirrored onto `AcpSession`'s `snapshot.connection`.
 *
 * Moved here (from `./session`, which re-exports it for backward
 * compatibility) so `client.ts` — which session.ts imports — can reference it
 * without an import cycle.
 *
 * `'open'` means the stream response is established (a successful fetch with
 * a readable body) — the same moment `EventSource.onopen` would fire — not
 * that a first event has actually arrived. An idle-but-healthy connection
 * must read as `'open'`, not `'reconnecting'`. Backoff-reset logic is
 * deliberately stricter than this: it only resets `retryMs` once an attempt
 * has delivered at least one event, so UI truth (`'open'`) and retry
 * conservatism are intentionally asymmetric.
 */
export type AcpConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';
