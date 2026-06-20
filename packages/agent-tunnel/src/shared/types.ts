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
  | 'desktop';

export const TunnelMethods = {
  'fs.read': 'filesystem',
  'fs.write': 'filesystem',
  'fs.list': 'filesystem',
  'fs.stat': 'filesystem',
  'fs.delete': 'filesystem',
  'shell.exec': 'shell',
  'desktop.cua.ensure': 'desktop',
  'desktop.cua.start_daemon': 'desktop',
  'desktop.cua.status': 'desktop',
  'desktop.cua.version': 'desktop',
  'desktop.cua.list_tools': 'desktop',
  'desktop.cua.describe': 'desktop',
  'desktop.cua.call': 'desktop',
  'desktop.cua.bring_to_front': 'desktop',
  'desktop.cua.check_for_update': 'desktop',
  'desktop.cua.check_permissions': 'desktop',
  'desktop.cua.click': 'desktop',
  'desktop.cua.double_click': 'desktop',
  'desktop.cua.drag': 'desktop',
  'desktop.cua.end_session': 'desktop',
  'desktop.cua.get_accessibility_tree': 'desktop',
  'desktop.cua.get_agent_cursor_state': 'desktop',
  'desktop.cua.get_config': 'desktop',
  'desktop.cua.get_cursor_position': 'desktop',
  'desktop.cua.get_recording_state': 'desktop',
  'desktop.cua.get_screen_size': 'desktop',
  'desktop.cua.get_window_state': 'desktop',
  'desktop.cua.hotkey': 'desktop',
  'desktop.cua.kill_app': 'desktop',
  'desktop.cua.launch_app': 'desktop',
  'desktop.cua.list_apps': 'desktop',
  'desktop.cua.list_windows': 'desktop',
  'desktop.cua.move_cursor': 'desktop',
  'desktop.cua.page': 'desktop',
  'desktop.cua.press_key': 'desktop',
  'desktop.cua.replay_trajectory': 'desktop',
  'desktop.cua.right_click': 'desktop',
  'desktop.cua.scroll': 'desktop',
  'desktop.cua.set_agent_cursor_enabled': 'desktop',
  'desktop.cua.set_agent_cursor_motion': 'desktop',
  'desktop.cua.set_agent_cursor_style': 'desktop',
  'desktop.cua.set_config': 'desktop',
  'desktop.cua.set_value': 'desktop',
  'desktop.cua.start_recording': 'desktop',
  'desktop.cua.install_ffmpeg': 'desktop',
  'desktop.cua.start_session': 'desktop',
  'desktop.cua.stop_recording': 'desktop',
  'desktop.cua.type_text': 'desktop',
  'desktop.cua.zoom': 'desktop',
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
