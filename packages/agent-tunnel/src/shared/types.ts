export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export const TunnelErrorCode = {
  PERMISSION_DENIED: -32000,
  CAPABILITY_NOT_REGISTERED: -32001,
  TIMEOUT: -32002,
  LOCAL_ERROR: -32003,
  NOT_CONNECTED: -32004,
  EXPIRED: -32005,
  RATE_LIMITED: -32006,
  AUTH_FAILED: -32007,
} as const;

export type TunnelErrorCodeValue = (typeof TunnelErrorCode)[keyof typeof TunnelErrorCode];

export type TunnelCapability =
  | 'filesystem'
  | 'shell'
  | 'network'
  | 'apps'
  | 'hardware'
  | 'desktop'
  | 'gpu';

export const TunnelMethods = {
  'fs.read': 'filesystem',
  'fs.write': 'filesystem',
  'fs.list': 'filesystem',
  'fs.stat': 'filesystem',
  'fs.delete': 'filesystem',
  'shell.exec': 'shell',
  'desktop.screenshot': 'desktop',
  'desktop.mouse.click': 'desktop',
  'desktop.mouse.move': 'desktop',
  'desktop.mouse.drag': 'desktop',
  'desktop.mouse.scroll': 'desktop',
  'desktop.mouse.position': 'desktop',
  'desktop.keyboard.type': 'desktop',
  'desktop.keyboard.key': 'desktop',
  'desktop.window.list': 'desktop',
  'desktop.window.focus': 'desktop',
  'desktop.window.resize': 'desktop',
  'desktop.window.close': 'desktop',
  'desktop.window.minimize': 'desktop',
  'desktop.app.launch': 'desktop',
  'desktop.app.quit': 'desktop',
  'desktop.app.list': 'desktop',
  'desktop.clipboard.read': 'desktop',
  'desktop.clipboard.write': 'desktop',
  'desktop.screen.info': 'desktop',
  'desktop.cursor.image': 'desktop',
  'desktop.ax.tree': 'desktop',
  'desktop.ax.action': 'desktop',
  'desktop.ax.set_value': 'desktop',
  'desktop.ax.focus': 'desktop',
  'desktop.ax.search': 'desktop',
  'net.request': 'network',
  'net.port_forward.start': 'network',
  'net.port_forward.stop': 'network',
  'tunnel.ping': null,
  'tunnel.pong': null,
  'tunnel.permission.revoked': null,
  'tunnel.permissions.sync': null,
  'tunnel.token.rotated': null,
} as const;

export type TunnelMethod = keyof typeof TunnelMethods;

export interface PendingRPC {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  tunnelId: string;
  startedAt: number;
}

export interface SignedJsonRpcRequest extends JsonRpcRequest {
  _sig: string;
  _nonce: number;
}

export interface SignedJsonRpcNotification extends JsonRpcNotification {
  _sig: string;
  _nonce: number;
}

export interface TunnelRpcParams {
  capability: TunnelCapability;
  operation: string;
  args: Record<string, unknown>;
  permissionId?: string;
}

export interface RelayRpcOptions {
  timeoutMs?: number;
}

/** Public agent info — does NOT expose signing key. */
export interface AgentInfo {
  tunnelId: string;
  connectedAt: number;
  metadata?: Record<string, unknown>;
}

export interface TunnelRelayEvents {
  'agent:connect': { tunnelId: string; metadata?: Record<string, unknown> };
  'agent:disconnect': { tunnelId: string };
  'agent:timeout': { tunnelId: string };
  'rpc:request': { tunnelId: string; method: string; requestId: string };
  'rpc:response': { tunnelId: string; method: string; requestId: string; durationMs: number };
  'rpc:error': { tunnelId: string; method: string; requestId: string; error: Error };
  'connection:replaced': { tunnelId: string };
  'message:pong': { tunnelId: string; params?: Record<string, unknown> };
  'message:raw': { tunnelId: string; message: unknown };
}

export interface TunnelRelayConfig {
  rpcTimeoutMs?: number;
  maxWsMessageSize?: number;
}

export interface HeartbeatConfig {
  intervalMs?: number;
  maxMissed?: number;
}

/** Auth handshake message sent by agent as first WS message. */
export interface TunnelAuthMessage {
  type: 'auth';
  token: string;
}

/** Result returned by onAuthenticate hook on success. */
export interface AuthResult {
  signingKey: string;
  metadata?: Record<string, unknown>;
}

export interface TunnelServerConfig {
  port?: number;
  relay?: TunnelRelayConfig;
  heartbeat?: HeartbeatConfig;
  /**
   * Called when an agent sends its auth handshake.
   * Return { signingKey, metadata } to accept, or null to reject.
   * If not provided, all connections are rejected.
   */
  onAuthenticate?: (tunnelId: string, token: string) => Promise<AuthResult | null>;
  /**
   * Called before relaying an RPC to the agent.
   * Return false to deny. If not provided, all RPCs are allowed.
   */
  onAuthorizeRPC?: (tunnelId: string, method: string, params: Record<string, unknown>) => Promise<boolean>;
  /**
   * Called before handling HTTP requests to relay routes (/connections, /rpc).
   * Return false to deny. If not provided, routes are open.
   */
  onAuthorizeHTTP?: (req: Request) => Promise<boolean>;
}
