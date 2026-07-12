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
