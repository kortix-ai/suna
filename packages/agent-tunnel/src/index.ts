// ─── Shared: Types + Crypto ─────────────────────────────────────────────────
export {
  deriveSigningKey,
  signMessage,
  verifyMessageSignature,
  generateToken,
  hashToken,
  timingSafeStringEqual,
  TunnelErrorCode,
  TunnelMethods,
} from './shared';

export type {
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  SignedJsonRpcRequest,
  SignedJsonRpcNotification,
  PendingRPC,
  TunnelRpcParams,
  RelayRpcOptions,
  AgentInfo,
  TunnelRelayEvents,
  TunnelRelayConfig,
  HeartbeatConfig,
  TunnelServerConfig,
  TunnelAuthMessage,
  AuthResult,
  TunnelCapability,
  TunnelMethod,
  TunnelErrorCodeValue,
} from './shared';

// ─── Server: Relay ──────────────────────────────────────────────────────────
export { TunnelRelay, TunnelRelayError } from './server';
export { HeartbeatManager } from './server';
export { createWsHandlers } from './server';
export type { WsHandlers, WsHandlerOptions } from './server';
export { createTunnelRouter } from './server';
export { startTunnelServer } from './server';
export type { TunnelServer } from './server';

// ─── Client: SDK ────────────────────────────────────────────────────────────
export { TunnelClient, TunnelClientError } from './client';
export type { TunnelClientConfig, AXElement } from './client';
export { createTunnelTools } from './client';
export type { TunnelToolDefinition, TunnelToolParameter } from './client';

// ─── Agent: Local Machine ───────────────────────────────────────────────────
export { TunnelAgent } from './agent';
export { loadConfig, type TunnelConfig } from './agent';
export { CapabilityRegistry } from './agent';
export type { Capability, RpcHandler } from './agent';
export { createFilesystemCapability } from './agent';
export { createShellCapability } from './agent';
export { createDesktopCapability } from './agent';
export { PermissionGuard } from './agent';
export type { LocalPermission } from './agent';
export { validateCommand } from './agent';
export { validatePath } from './agent';
