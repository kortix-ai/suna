import { spawn, type ChildProcess } from 'child_process';
import { hostname, platform, arch, release } from 'os';
import { buildTunnelWsUrl, trustedCredential, type TunnelConfig } from './config';
import {
  ACCESS_HOLD_MS,
  clearAccessRequest,
  decideAccess,
  keepAwakeCommand,
  readAccess,
  readAccessRequest,
  wakeDesktopApp,
  writeAccessRequest,
} from './access';
import { agentTunnelHome } from './service-paths';
import { machineDisplayName, machineId } from './device-auth';
import { capabilityForMethod } from '../shared/permissions';
import { TunnelErrorCode } from '../shared/types';
import { agentTunnelVersion } from './version';
import { c } from './terminal';
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
 * Relays before 0.1.3 also closed with 4001 when THEY failed (auth timeout,
 * database error during a deploy). Those reasons are retryable: treating them
 * as a bad credential stopped the background service for good.
 */
const RELAY_FAULT_4001_REASONS = new Set(['auth timeout', 'authentication error', 'authentication response failed']);

export function isCredentialRejection(code: number, reason = ''): boolean {
  if (!AUTH_REJECTED_CLOSE_CODES.includes(code)) return false;
  return !(code === 4001 && RELAY_FAULT_4001_REASONS.has(reason));
}

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

function log(icon: string, msg: string) {
  const safeIcon = icon.replace(/[\r\n]/g, ' ');
  const safeMsg = msg.replace(/[\r\n]/g, ' ');
  process.stdout.write(`  ${safeIcon} ${c.dim}${safeMsg}${c.reset}\n`);
}

/**
 * `rejected` and `standby` exist only in service mode: the credential was
 * refused, or another process holds the tunnel. The agent keeps retrying.
 */
export type TunnelAgentStatus = 'connecting' | 'online' | 'offline' | 'rejected' | 'standby';

export interface TunnelAgentOptions {
  /** Service mode (R2): never stop on a refused credential or on being replaced. */
  persistent?: boolean;
  /** Re-read the credential before a retry, so a re-pair heals a `rejected` agent. */
  reloadConfig?: () => TunnelConfig;
  /** Config directory holding access.json. */
  home?: string;
  livenessTimeoutMs?: number;
  watchdogIntervalMs?: number;
  rejectedRetryMs?: number;
  standbyRetryMs?: number;
  connectDeadlineMs?: number;
  accessHoldMs?: number;
  now?: () => number;
}

/** The relay pings every 30 s; 75 s of silence means the socket is dead (R1). */
const LIVENESS_TIMEOUT_MS = 75_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/** A tick that arrives this much later than scheduled means the machine slept. */
const CLOCK_JUMP_MS = 30_000;
const REJECTED_RETRY_MS = 5 * 60_000;
/**
 * The one command that pairs this computer again. An npx user has no
 * `agent-tunnel` on PATH, so the hint names the package. The relay removes a
 * computer when its owner disconnects it, and a registration without a
 * hardware id after 30 days without a sign of life.
 */
export const PAIR_AGAIN_COMMAND = 'npx @kortix/agent-tunnel@latest connect --reauth';
const NO_LONGER_CONNECTED = 'This computer is no longer connected to Kortix (disconnected, or removed after 30 days offline).';
/** Standby backs off from this, doubling, so two holders of one credential stop trading the socket. */
const STANDBY_RETRY_MS = 60_000;
const MAX_STANDBY_RETRY_MS = 30 * 60_000;
/** A handshake that has not reached auth_ok by now is dead (frozen relay, dropped Wi-Fi). */
const CONNECT_DEADLINE_MS = 20_000;
/** A keep-awake helper that exits sooner than this could not take the lock. */
const KEEP_AWAKE_MIN_LIFETIME_MS = 5_000;
const REJECTED_LOG_EVERY_MS = 3_600_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** R4: exponential from 1 s, ±20 % jitter, never above 30 s. */
export function reconnectDelay(attempt: number, random = Math.random()): number {
  const raw = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 30), MAX_RECONNECT_DELAY_MS);
  return Math.round(Math.min(raw * (0.8 + 0.4 * random), MAX_RECONNECT_DELAY_MS));
}

const ACCESS_ERRORS = {
  pending: {
    code: TunnelErrorCode.ACCESS_PENDING,
    message: 'computer_access_pending: The owner has not allowed access yet. Ask them to approve the prompt on their computer, then try again.',
  },
  denied: {
    code: TunnelErrorCode.ACCESS_DENIED,
    message: 'computer_access_denied: The owner denied access on their computer. Try again later.',
  },
  off: {
    code: TunnelErrorCode.ACCESS_OFF,
    message: 'computer_access_off: The owner turned off access to this computer.',
  },
} as const;

export interface TunnelAgentHooks {
  /** Fires on every change of connection status, with the credential in use now. */
  onStatus?: (status: TunnelAgentStatus, config: TunnelConfig) => void;
  /**
   * Fires when the relay closes the connection for a reason reconnecting cannot
   * fix. The agent has already stopped retrying by this point.
   */
  onTerminalClose?: (info: { code: number; reason: TerminalCloseReason }) => void;
}

export type TerminalCloseReason = 'credential-rejected' | 'replaced';

export class TunnelAgent {
  private hooks: TunnelAgentHooks;
  private options: TunnelAgentOptions;
  private home: string;
  private now: () => number;
  private ws: WebSocket | null = null;
  private registry: CapabilityRegistry;
  private permissionGuard: PermissionGuard;
  private config: TunnelConfig;
  private reconnectAttempts = 0;
  private closeCurrentSocket: ((event: { code: number; reason?: string }) => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastPingAt = 0;
  private connectStartedAt = 0;
  private standbyAttempts = 0;
  private lastRejectedLogAt = 0;
  private sentAccessKey: string | null = null;
  private keepAwake: ChildProcess | null = null;
  private keepAwakeFailed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private status: TunnelAgentStatus | null = null;
  private uptime = 0;
  /** Read once: on macOS it runs `scutil`, and the pong repeats every 30 s. */
  private displayName?: string;
  /** Hashed hardware id, read once (null when unreadable). */
  private readonly hardwareId = machineId();
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;

  // HMAC signature verification
  private signingKey: string | null = null;
  private lastNonce = 0;
  private responseNonce = 0;

  constructor(
    config: TunnelConfig,
    registry: CapabilityRegistry,
    hooks: TunnelAgentHooks = {},
    options: TunnelAgentOptions = {},
  ) {
    this.config = config;
    this.registry = registry;
    this.permissionGuard = new PermissionGuard();
    this.hooks = hooks;
    this.options = options;
    this.home = options.home ?? agentTunnelHome();
    this.now = options.now ?? Date.now;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }
    this.startWatchdog();

    const wsUrl = this.buildWsUrl();
    log(`${c.cyan}◆${c.reset}`, `Connecting…`);
    this.connectStartedAt = this.now();
    this.setStatus('connecting');

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
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.syncKeepAwake(false);

    if (this.ws) {
      try { this.ws.close(1000, 'client shutdown'); } catch {}
      this.ws = null;
    }

    this.permissionGuard.clear();
    log(`${c.gray}○${c.reset}`, `Disconnected`);
    this.setStatus('offline');
  }

  private setStatus(status: TunnelAgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    try { this.hooks.onStatus?.(status, this.config); } catch {}
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
        reportsAccess: true,
      });
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    // Handled once per socket: the 'close' event, or the stand-in below.
    let closeHandled = false;
    const onClose = (event: { code: number; reason?: string }) => {
      if (closeHandled) return;
      closeHandled = true;
      this.setStatus('offline');
      if (this.uptimeInterval) {
        clearInterval(this.uptimeInterval);
        this.uptimeInterval = null;
      }
      if (this.stableConnectionTimer) {
        clearTimeout(this.stableConnectionTimer);
        this.stableConnectionTimer = null;
      }

      if (!this.isShuttingDown) {
        if (this.options.persistent && isCredentialRejection(event.code, event.reason)) {
          this.setStatus('rejected');
          if (this.now() - this.lastRejectedLogAt >= REJECTED_LOG_EVERY_MS) {
            this.lastRejectedLogAt = this.now();
            log(
              `${c.red}✗${c.reset}`,
              `${NO_LONGER_CONNECTED} Connect it again from the Kortix desktop app, or run \`${PAIR_AGAIN_COMMAND}\`. Checking again every 5 min.`,
            );
          }
          this.retryAfter(this.options.rejectedRetryMs ?? REJECTED_RETRY_MS);
          return;
        }
        if (this.options.persistent && event.code === AGENT_REPLACED_CLOSE_CODE) {
          this.setStatus('standby');
          const wait = Math.min((this.options.standbyRetryMs ?? STANDBY_RETRY_MS) * 2 ** this.standbyAttempts++, MAX_STANDBY_RETRY_MS);
          log(`${c.yellow}○${c.reset}`, `Another Agent Tunnel process holds this computer — standing by, next try in ${Math.round(wait / 1000)}s`);
          this.retryAfter(wait);
          return;
        }
        if (event.code === 4001 && isCredentialRejection(event.code, event.reason)) {
          this.isShuttingDown = true;
          log(`${c.red}✗${c.reset}`, `${NO_LONGER_CONNECTED} Connect it again: \`${PAIR_AGAIN_COMMAND}\``);
          this.hooks.onTerminalClose?.({ code: event.code, reason: 'credential-rejected' });
          return; // Don't reconnect on auth failure
        }
        if (event.code === 4003) {
          this.isShuttingDown = true;
          log(`${c.red}✗${c.reset}`, `${NO_LONGER_CONNECTED} Connect it again: \`${PAIR_AGAIN_COMMAND}\``);
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
    };
    this.ws.addEventListener('close', onClose);
    this.closeCurrentSocket = onClose;

    this.ws.addEventListener('error', () => {
      log(`${c.red}✗${c.reset}`, `WebSocket error`);
      // Node's built-in WebSocket fires no 'close' after a failed handshake
      // (relay unreachable). With nothing left pending the process then exits
      // 0, which no supervisor restarts: a machine that booted offline stayed
      // offline. An error only ever precedes an abnormal closure, so stand in
      // for it with 1006 when the real event does not follow.
      setTimeout(() => onClose({ code: 1006 }), 1_000);
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
          `Connected, but no capabilities are enabled — this tunnel cannot do anything. Run \`${PAIR_AGAIN_COMMAND}\` to pair again.`,
        );
      } else {
        log(`${c.green}●${c.reset}`, `Connected ${c.reset}${c.gray}(${capabilityNames.join(', ')})${c.reset}`);
      }
      this.lastPingAt = this.now();
      this.sentAccessKey = null;
      this.standbyAttempts = 0;
      this.setStatus('online');
      this.reportAccess();
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
      this.lastPingAt = this.now();
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

    const refusal = await this.awaitAccess(method);
    if (refusal) {
      this.sendSignedError(id, refusal.code, refusal.message);
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
          displayName: (this.displayName ??= machineDisplayName()),
          // Registers this machine's identity on its row, so re-pairing it
          // later reuses the registration instead of adding a second one.
          ...(this.hardwareId ? { machineId: this.hardwareId } : {}),
          platform: platform(),
          arch: arch(),
          osVersion: release(),
          agentVersion: AGENT_VERSION,
          // Where file and shell work may happen, so a cloud agent starts in
          // the right place instead of probing paths the local ceiling denies.
          homeDir: this.config.workingDir,
          allowedPaths: this.config.allowedPaths,
        },
      },
    });
  }

  /**
   * A2/A3: the owner's standing answer in access.json decides. `ask` without a
   * grant writes access-request.json, wakes the desktop app, and holds the call
   * until the owner answers or the hold runs out.
   */
  private async awaitAccess(method: string): Promise<(typeof ACCESS_ERRORS)[keyof typeof ACCESS_ERRORS] | null> {
    const first = decideAccess(readAccess(this.home));
    if (first === 'run') return null;
    if (first !== 'ask') return ACCESS_ERRORS[first];

    const hold = this.options.accessHoldMs ?? ACCESS_HOLD_MS;
    let requestId: string | null = null;
    try {
      // Concurrent calls share one pending request: one prompt, one app launch.
      const pending = readAccessRequest(this.home);
      if (pending && Date.now() - Date.parse(pending.requestedAt) < hold) {
        requestId = pending.id;
      } else {
        requestId = writeAccessRequest({ capability: capabilityForMethod(method) ?? method, method }, this.home).id;
        wakeDesktopApp(this.home);
      }
    } catch {
      // Without a request file nobody can answer; the hold simply runs out.
    }
    const deadline = Date.now() + hold;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, hold / 4)));
      const decision = decideAccess(readAccess(this.home));
      if (decision === 'ask') continue;
      if (requestId) clearAccessRequest(requestId, this.home);
      return decision === 'run' ? null : ACCESS_ERRORS[decision];
    }
    // The request stays: a late answer still applies to the next call.
    return ACCESS_ERRORS.pending;
  }

  /** X2: optional signed notification; relays that do not know it ignore it. */
  private reportAccess(): void {
    const access = readAccess(this.home);
    const { mode } = access;
    // A lapsed grant is no grant: the watchdog reports again when it expires.
    const grantedUntil = access.grantedUntil && Date.parse(access.grantedUntil) > this.now() ? access.grantedUntil : null;
    const key = `${mode}|${grantedUntil}`;
    if (key === this.sentAccessKey || this.status !== 'online') return;
    this.sentAccessKey = key;
    this.sendSigned({ jsonrpc: '2.0', method: 'tunnel.access.state', params: { mode, grantedUntil } });
  }

  /** R6: hold a sleep blocker while access.json asks for it. */
  private syncKeepAwake(want: boolean): void {
    if (!want) {
      this.keepAwake?.kill();
      this.keepAwake = null;
      // Toggling keep awake off and on again is the owner's retry.
      this.keepAwakeFailed = false;
      return;
    }
    if (this.keepAwake || this.keepAwakeFailed) return;
    const blocker = keepAwakeCommand(platform(), process.pid);
    if (!blocker) return;
    const child = spawn(blocker.command, blocker.args, { stdio: 'ignore' });
    child.on('error', () => {
      this.keepAwakeFailed = true;
      log(`${c.yellow}!${c.reset}`, `Keep awake is unavailable: ${blocker.command} could not start`);
    });
    const startedAt = this.now();
    child.on('exit', (code) => {
      if (this.keepAwake !== child) return; // we killed it
      this.keepAwake = null;
      // e.g. polkit refused systemd-inhibit: respawning every 5 s would never help.
      if (code !== 0 || this.now() - startedAt < KEEP_AWAKE_MIN_LIFETIME_MS) {
        this.keepAwakeFailed = true;
        log(`${c.yellow}!${c.reset}`, `Keep awake is unavailable: ${blocker.command} exited (code ${code})`);
      }
    });
    this.keepAwake = child;
  }

  /** R1: liveness, wake-from-sleep, and access.json changes, every 5 s. */
  private startWatchdog(): void {
    if (this.watchdog) return;
    const interval = this.options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS;
    this.lastTick = this.now();
    this.watchdog = setInterval(() => {
      const now = this.now();
      const slept = now - this.lastTick > interval + CLOCK_JUMP_MS;
      this.lastTick = now;
      if (slept) {
        // A wake is a fresh start: backoff built up before the sleep must not delay it.
        this.reconnectAttempts = 0;
        this.forceReconnect('clock jump');
      }
      else if (this.status === 'online' && now - this.lastPingAt > (this.options.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS)) {
        this.forceReconnect('liveness timeout');
      } else if (this.status === 'connecting' && this.ws && now - this.connectStartedAt > (this.options.connectDeadlineMs ?? CONNECT_DEADLINE_MS)) {
        this.forceReconnect('handshake timeout');
      } else if (this.status === 'rejected' && this.credentialChanged()) {
        this.forceReconnect('new credential');
      }
      try {
        const access = readAccess(this.home);
        this.syncKeepAwake(access.keepAwake);
        this.reportAccess();
      } catch {}
    }, interval);
    this.watchdog.unref?.();
  }

  /** R2: a re-pair wrote a new credential; a `rejected` agent uses it at once. */
  private credentialChanged(): boolean {
    try {
      const next = this.options.reloadConfig?.();
      if (!next || (next.token === this.config.token && next.tunnelId === this.config.tunnelId)) return false;
      this.config = next;
      return true;
    } catch {
      return false;
    }
  }

  /** Drops a socket that may be half-open and reconnects without waiting for its close. */
  private forceReconnect(reason: string): void {
    if (this.isShuttingDown) return;
    if (!this.ws) {
      // Waiting out a backoff: after a sleep, try at once.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.connect();
      }
      return;
    }
    log(`${c.yellow}○${c.reset}`, `Reconnecting (${reason})`);
    try { this.ws.close(4000, reason); } catch {}
    this.ws = null;
    this.closeCurrentSocket?.({ code: 4000, reason });
  }

  private retryAfter(ms: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        if (this.options.reloadConfig) this.config = this.options.reloadConfig();
      } catch {}
      this.connect();
    }, ms);
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    this.reconnectAttempts++;
    const delay = reconnectDelay(this.reconnectAttempts);
    this.ws = null;

    log(`${c.cyan}◆${c.reset}`, `Reconnecting in ${c.reset}${c.white}${(delay / 1000).toFixed(1)}s${c.dim} (attempt ${this.reconnectAttempts})`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private buildWsUrl(): string {
    return buildTunnelWsUrl(this.config);
  }
}
