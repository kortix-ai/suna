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
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      mimeType?: string;
    };

export type AcpStreamEvent = {
  id: number;
  envelope: AcpEnvelope;
};

export type AcpStoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: AcpEnvelope;
  createdAt: string;
};

export type AcpTranscript = {
  runtime_id: string;
  envelopes: AcpStoredEnvelope[];
};

export type AcpStreamHandle = {
  close(): void;
  readonly lastEventId: number;
  /** Resolves after the first SSE response is open and can receive replies. */
  readonly ready: Promise<void>;
};

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
