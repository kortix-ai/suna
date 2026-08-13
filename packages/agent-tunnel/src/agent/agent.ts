import { hostname, platform, arch, release } from 'os';
import { buildTunnelWsUrl, trustedCredential, type TunnelConfig } from './config';
import { agentTunnelVersion } from './version';
import { CapabilityRegistry } from './capabilities/index';
import { PermissionGuard } from './security/permission-guard';
import type { LocalPermission } from './security/permission-guard';
import { signMessage, verifyMessageSignature } from '../shared/crypto';

export const AGENT_VERSION = agentTunnelVersion();

/**
 * Relay close codes that mean the credential itself is bad. They are terminal:
 * reconnecting with the same token can never succeed.
 */
export const AUTH_REJECTED_CLOSE_CODES: readonly number[] = [4001, 4003];

/**
 * The relay closes an already-registered socket with this code when a second
 * process authenticates with the same credential. Only one agent may hold a
 * tunnel, so this is terminal for the displaced process.
 */
export const AGENT_REPLACED_CLOSE_CODE = 4004;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
  _sig?: string;
  _nonce?: number;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  _sig?: string;
  _nonce?: number;
}

type IncomingMessage = JsonRpcRequest | JsonRpcNotification;
const MAX_RPC_MESSAGE_SIZE = 5 * 1024 * 1024;

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
};

function log(icon: string, msg: string) {
  const safeIcon = icon.replace(/[\r\n]/g, ' ');
  const safeMsg = msg.replace(/[\r\n]/g, ' ');
  process.stdout.write(`  ${safeIcon} ${c.dim}${safeMsg}${c.reset}\n`);
}

export interface TunnelAgentHooks {
  /**
   * Fires when the relay closes the connection for a reason reconnecting cannot
   * fix. The agent has already stopped retrying by this point.
   */
  onTerminalClose?: (info: { code: number; reason: TerminalCloseReason }) => void;
}

export type TerminalCloseReason = 'credential-rejected' | 'replaced';

export class TunnelAgent {
  private hooks: TunnelAgentHooks;
  private ws: WebSocket | null = null;
  private registry: CapabilityRegistry;
  private permissionGuard: PermissionGuard;
  private config: TunnelConfig;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private uptime = 0;
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;

  // HMAC signature verification
  private signingKey: string | null = null;
  private lastNonce = 0;
  private responseNonce = 0;

  constructor(config: TunnelConfig, registry: CapabilityRegistry, hooks: TunnelAgentHooks = {}) {
    this.config = config;
    this.registry = registry;
    this.permissionGuard = new PermissionGuard();
    this.hooks = hooks;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrl = this.buildWsUrl();
    log(`${c.cyan}◆${c.reset}`, `Connecting…`);

    try {
      // lgtm[js/file-access-to-http] Tunnel endpoint is intentionally loaded from trusted local config.
      this.ws = new WebSocket(new URL(wsUrl));
      this.setupWsHandlers();
    } catch (err) {
      log(`${c.red}✗${c.reset}`, `Connection failed`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }

    if (this.ws) {
      try { this.ws.close(1000, 'client shutdown'); } catch {}
      this.ws = null;
    }

    this.permissionGuard.clear();
    log(`${c.gray}○${c.reset}`, `Disconnected`);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setupWsHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('open', () => {
      this.uptime = 0;
      this.lastNonce = 0;
      this.responseNonce = 0;
      this.signingKey = null;
      this.uptimeInterval = setInterval(() => { this.uptime++; }, 1000);

      // Send auth handshake as first message (token never in URL)
      this.send({
        type: 'auth',
        token: trustedCredential(this.config.token, 'token'),
        capabilities: this.registry.getCapabilityNames(),
        agentVersion: AGENT_VERSION,
      });
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event) => {
      if (this.uptimeInterval) {
        clearInterval(this.uptimeInterval);
        this.uptimeInterval = null;
      }
      if (this.stableConnectionTimer) {
        clearTimeout(this.stableConnectionTimer);
        this.stableConnectionTimer = null;
      }

      if (!this.isShuttingDown) {
        if (event.code === 4001) {
          this.isShuttingDown = true;
          log(`${c.red}✗${c.reset}`, `Credential rejected — run \`agent-tunnel connect --reauth\` to pair again`);
          this.hooks.onTerminalClose?.({ code: event.code, reason: 'credential-rejected' });
          return; // Don't reconnect on auth failure
        }
        if (event.code === 4003) {
          this.isShuttingDown = true;
          log(`${c.red}✗${c.reset}`, `Device credential was revoked — run \`agent-tunnel connect --reauth\` to pair again`);
          this.hooks.onTerminalClose?.({ code: event.code, reason: 'credential-rejected' });
          return;
        }
        if (event.code === AGENT_REPLACED_CLOSE_CODE) {
          this.isShuttingDown = true;
          log(
            `${c.yellow}○${c.reset}`,
            `Another Agent Tunnel process connected with these credentials — stopping this process`,
          );
          this.hooks.onTerminalClose?.({ code: event.code, reason: 'replaced' });
          return;
        }
        log(`${c.yellow}○${c.reset}`, `Disconnected ${c.gray}(code: ${event.code})${c.reset}`);
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      log(`${c.red}✗${c.reset}`, `WebSocket error`);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RPC_MESSAGE_SIZE) {
      log(`${c.red}✗${c.reset}`, `Rejected oversized or non-text relay message`);
      try { this.ws?.close(4002, 'message too large'); } catch {}
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      log(`${c.yellow}!${c.reset}`, `Received invalid JSON`);
      return;
    }

    // Handle auth_ok — server sends signing key after successful auth
    if (msg.type === 'auth_ok' && msg.signingKey) {
      this.signingKey = msg.signingKey;
      const capabilityNames = this.registry.getCapabilityNames();
      if (capabilityNames.length === 0) {
        // Reporting a bare "Connected ()" hides that this tunnel is inert.
        log(
          `${c.yellow}!${c.reset}`,
          `Connected, but no capabilities are enabled — this tunnel cannot do anything. Run \`agent-tunnel connect --reauth\` to pair again.`,
        );
      } else {
        log(`${c.green}●${c.reset}`, `Connected ${c.reset}${c.gray}(${capabilityNames.join(', ')})${c.reset}`);
      }
      if (this.stableConnectionTimer) clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.stableConnectionTimer = null;
      }, 30_000);
      return;
    }

    if (!this.signingKey) {
      log(`${c.yellow}!${c.reset}`, `Message received before auth completed`);
      return;
    }

    if (!this.verifyIncomingSignature(msg, raw)) {
      if ('id' in msg && msg.id) {
        this.sendSignedError(msg.id, -32000, 'Invalid message signature');
      }
      return;
    }

    // ── Heartbeat ping (signature verified above) ────────────────────
    if ('method' in msg && msg.method === 'tunnel.ping') {
      this.sendPong();
      return;
    }

    // ── Permission sync notification ────────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permissions.sync') {
      const permissions = (msg.params?.permissions || []) as LocalPermission[];
      this.permissionGuard.syncPermissions(permissions);
      log(`${c.green}●${c.reset}`, `Synced ${c.reset}${c.white}${permissions.length}${c.dim} permissions`);
      return;
    }

    // ── Permission granted notification ────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permission.granted') {
      const p = msg.params as LocalPermission | undefined;
      if (p?.permissionId) {
        this.permissionGuard.addPermission(p);
        log(`${c.green}+${c.reset}`, `Permission granted: ${p.capability} (${p.permissionId.slice(0, 12)}…)`);
      }
      return;
    }

    // ── Permission revocation notification ──────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permission.revoked') {
      const permissionId = msg.params?.permissionId as string;
      if (permissionId) {
        this.permissionGuard.revokePermission(permissionId);
        log(`${c.yellow}○${c.reset}`, `Permission revoked: ${permissionId.slice(0, 12)}…`);
      }
      return;
    }

    // ── Token rotation notification ─────────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.token.rotated') {
      log(`${c.yellow}!${c.reset}`, `Token rotated — reconnecting with new token`);
      return;
    }

    // ── RPC request dispatch ────────────────────────────────────────
    if ('id' in msg && msg.id) {
      await this.handleRpcRequest(msg as JsonRpcRequest);
      return;
    }
  }

  /**
   * Verify HMAC signature on incoming messages (excluding pings).
   */
  private verifyIncomingSignature(msg: IncomingMessage, _raw: string): boolean {
    const sig = (msg as any)._sig as string | undefined;
    const nonce = (msg as any)._nonce as number | undefined;

    if (sig === undefined || nonce === undefined) {
      log(`${c.yellow}!${c.reset}`, `Message missing signature fields`);
      return false;
    }

    if (nonce <= this.lastNonce) {
      log(`${c.red}✗${c.reset}`, `Replay detected: nonce ${nonce} <= ${this.lastNonce}`);
      return false;
    }

    const { _sig, _nonce, ...payloadObj } = msg as any;
    const payload = JSON.stringify(payloadObj);

    if (!verifyMessageSignature(this.signingKey!, payload, nonce, sig)) {
      log(`${c.red}✗${c.reset}`, `Invalid HMAC signature`);
      return false;
    }

    this.lastNonce = nonce;
    return true;
  }

  private async handleRpcRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = request;

    const permissionId = params.permissionId as string | undefined;
    const permission = this.permissionGuard.getPermissionForMethod(permissionId, method);
    if (!permission) {
      this.sendSignedError(id, -32000, `Permission denied: ${permissionId ? 'invalid or expired permission' : 'no permissionId provided'}`);
      return;
    }

    const handler = this.registry.getHandler(method);
    if (!handler) {
      this.sendSignedError(id, -32001, `Capability not registered for method: ${method}`);
      return;
    }

    try {
      const result = await handler({
        ...params,
        __permission: permission,
      });
      this.sendSignedResult(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendSignedError(id, -32003, message);
    }
  }

  /** Send HMAC-signed RPC result. */
  private sendSignedResult(id: string, result: unknown): void {
    const data = { jsonrpc: '2.0' as const, id, result };
    this.sendSigned(data);
  }

  /** Send HMAC-signed RPC error. */
  private sendSignedError(id: string, code: number, message: string): void {
    const data = { jsonrpc: '2.0' as const, id, error: { code, message } };
    this.sendSigned(data);
  }

  private sendSigned(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.signingKey) {
      const nonce = ++this.responseNonce;
      const payload = JSON.stringify(data);
      const sig = signMessage(this.signingKey, payload, nonce);
      const signed = { ...data, _sig: sig, _nonce: nonce };
      try {
        const encoded = JSON.stringify(signed);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_RPC_MESSAGE_SIZE) {
          if ('result' in data && typeof data.id === 'string') {
            this.sendSignedError(
              data.id,
              -32003,
              'RPC result exceeds the maximum tunnel message size',
            );
            return;
          }
          this.ws.close(4002, 'message too large');
          return;
        }
        this.ws.send(encoded);
      } catch (err) {
        log(`${c.red}✗${c.reset}`, `Send failed`);
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        // The auth handshake carries the credential read from the local config
        // file to the relay by design. loadConfig() validates the file and
        // trustedCredential() rejects control characters before it gets here.
        // lgtm[js/file-access-to-http]
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        log(`${c.red}✗${c.reset}`, `Send failed`);
      }
    }
  }

  private sendPong(): void {
    this.sendSigned({
      jsonrpc: '2.0',
      method: 'tunnel.pong',
      params: {
        uptime: this.uptime,
        capabilities: this.registry.getCapabilityNames(),
        machineInfo: {
          hostname: hostname(),
          platform: platform(),
          arch: arch(),
          osVersion: release(),
          agentVersion: AGENT_VERSION,
        },
      },
    });
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    log(`${c.cyan}◆${c.reset}`, `Reconnecting in ${c.reset}${c.white}${(delay / 1000).toFixed(1)}s${c.dim} (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private buildWsUrl(): string {
    return buildTunnelWsUrl(this.config);
  }
}
