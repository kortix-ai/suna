import { hostname, platform, arch, release } from 'os';
import type { TunnelConfig } from './config';
import { CapabilityRegistry, type RpcHandler } from './capabilities/index';
import { PermissionGuard } from './security/permission-guard';
import type { LocalPermission } from './security/permission-guard';
import { signMessage, verifyMessageSignature } from '../shared/crypto';

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
  console.log(`  ${icon} ${c.dim}${msg}${c.reset}`);
}

export class TunnelAgent {
  private ws: WebSocket | null = null;
  private registry: CapabilityRegistry;
  private permissionGuard: PermissionGuard;
  private config: TunnelConfig;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private uptime = 0;
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;

  // HMAC signature verification
  private signingKey: string | null = null;
  private lastNonce = 0;
  private responseNonce = 0;

  constructor(config: TunnelConfig, registry: CapabilityRegistry) {
    this.config = config;
    this.registry = registry;
    this.permissionGuard = new PermissionGuard();
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrl = this.buildWsUrl();
    log(`${c.cyan}◆${c.reset}`, `Connecting…`);

    try {
      this.ws = new WebSocket(wsUrl);
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
      this.reconnectAttempts = 0;
      this.uptime = 0;
      this.lastNonce = 0;
      this.responseNonce = 0;
      this.signingKey = null;
      this.uptimeInterval = setInterval(() => { this.uptime++; }, 1000);

      // Send auth handshake as first message (token never in URL)
      this.send({ type: 'auth', token: this.config.token });
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event) => {
      if (this.uptimeInterval) {
        clearInterval(this.uptimeInterval);
        this.uptimeInterval = null;
      }

      if (!this.isShuttingDown) {
        if (event.code === 4001) {
          log(`${c.red}✗${c.reset}`, `Authentication failed — check your token`);
          return; // Don't reconnect on auth failure
        }
        log(`${c.yellow}○${c.reset}`, `Disconnected ${c.gray}(code: ${event.code})${c.reset}`);
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', (event) => {
      log(`${c.red}✗${c.reset}`, `WebSocket error`);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
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
      log(`${c.green}●${c.reset}`, `Connected ${c.reset}${c.gray}(${this.registry.getCapabilityNames().join(', ')})${c.reset}`);
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
    if (!this.permissionGuard.checkPermission(permissionId)) {
      this.sendSignedError(id, -32000, `Permission denied: ${permissionId ? 'invalid or expired permission' : 'no permissionId provided'}`);
      return;
    }

    const handler = this.registry.getHandler(method);
    if (!handler) {
      this.sendSignedError(id, -32001, `Capability not registered for method: ${method}`);
      return;
    }

    try {
      const result = await handler(params);
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
        this.ws.send(JSON.stringify(signed));
      } catch (err) {
        log(`${c.red}✗${c.reset}`, `Send failed`);
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
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
          agentVersion: '0.1.2',
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
    const base = this.config.apiUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');

    if (base.startsWith('ws://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
      log(`${c.red}!${c.reset}`, `${c.red}WARNING: Connecting over unencrypted ws:// to a remote host. Token will be sent in plaintext. Use https:// API URL for production.${c.reset}`);
    }

    const wsPath = this.config.wsPath || '/ws';
    const params = new URLSearchParams({
      tunnelId: this.config.tunnelId,
    });

    return `${base}${wsPath}?${params.toString()}`;
  }
}
