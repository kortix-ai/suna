import { afterEach, describe, expect, test } from 'bun:test';

import { TunnelAgent, isCredentialRejection, type TunnelAgentStatus } from './agent';
import { CapabilityRegistry } from './capabilities/index';
import { loadConfig } from './config';

const RealWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
});

/** Node 22's built-in WebSocket on a refused connection: 'error', and no 'close'. */
class ErrorOnlyWebSocket extends EventTarget {
  static OPEN = 1;
  static created = 0;
  readyState = 3;
  constructor(_url: URL) {
    super();
    ErrorOnlyWebSocket.created++;
    setTimeout(() => this.dispatchEvent(new Event('error')), 5);
  }
  close() {}
  send() {}
}

describe('TunnelAgent connection status', () => {
  test('reconnects and reports offline when the relay is unreachable and no close event follows', async () => {
    globalThis.WebSocket = ErrorOnlyWebSocket as unknown as typeof WebSocket;
    ErrorOnlyWebSocket.created = 0;
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(
      loadConfig({
        apiUrl: 'http://127.0.0.1:9/v1/tunnel',
        token: 'kortix_tnl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
        tunnelId: '00000000-0000-4000-8000-000000000001',
      }),
      new CapabilityRegistry(),
      { onStatus: (status) => statuses.push(status) },
    );
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      agent.connect();
      // error at 5 ms, stand-in close at ~1 s, reconnect after the 1 s backoff.
      await Bun.sleep(2_300);
    } finally {
      agent.disconnect();
      process.stdout.write = originalWrite;
    }
    expect(ErrorOnlyWebSocket.created).toBeGreaterThanOrEqual(2);
    expect(statuses.slice(0, 3)).toEqual(['connecting', 'offline', 'connecting']);
  });
});

/** Opens, then closes with the given code/reason once the agent sends auth. */
function closingWebSocket(code: number, reason: string) {
  return class extends EventTarget {
    static OPEN = 1;
    static created = 0;
    readyState = 1;
    constructor(_url: URL) {
      super();
      (this.constructor as unknown as { created: number }).created++;
      setTimeout(() => this.dispatchEvent(new Event('open')), 1);
    }
    send() {
      setTimeout(() => {
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
      }, 1);
    }
    close() {}
  };
}

function quietAgent(onTerminalClose: (e: { reason: string }) => void, statuses: TunnelAgentStatus[]) {
  return new TunnelAgent(
    loadConfig({
      apiUrl: 'http://127.0.0.1:9/v1/tunnel',
      token: 'kortix_tnl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      tunnelId: '00000000-0000-4000-8000-000000000001',
    }),
    new CapabilityRegistry(),
    { onStatus: (status) => statuses.push(status), onTerminalClose },
  );
}

describe('TunnelAgent auth close handling', () => {
  test('a 4001 caused by a relay-side auth error is retried, not treated as a bad credential', async () => {
    const Socket = closingWebSocket(4001, 'authentication error');
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const terminal: string[] = [];
    const statuses: TunnelAgentStatus[] = [];
    const agent = quietAgent((e) => terminal.push(e.reason), statuses);
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      agent.connect();
      await Bun.sleep(1_300);
    } finally {
      agent.disconnect();
      process.stdout.write = originalWrite;
    }
    expect(terminal).toEqual([]);
    expect(Socket.created).toBeGreaterThanOrEqual(2);
  });

  test('a 4001 for a refused secret still stops the agent', async () => {
    globalThis.WebSocket = closingWebSocket(4001, 'authentication failed') as unknown as typeof WebSocket;
    const terminal: string[] = [];
    const agent = quietAgent((e) => terminal.push(e.reason), []);
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      agent.connect();
      await Bun.sleep(50);
    } finally {
      agent.disconnect();
      process.stdout.write = originalWrite;
    }
    expect(terminal).toEqual(['credential-rejected']);
  });

  test('isCredentialRejection separates bad credentials from relay trouble', () => {
    expect(isCredentialRejection(4001, 'authentication failed')).toBe(true);
    expect(isCredentialRejection(4001, 'auth failed')).toBe(true);
    expect(isCredentialRejection(4003, '')).toBe(true);
    expect(isCredentialRejection(4001, 'authentication error')).toBe(false);
    expect(isCredentialRejection(4001, 'auth timeout')).toBe(false);
    expect(isCredentialRejection(4001, 'authentication response failed')).toBe(false);
    expect(isCredentialRejection(1011, 'authentication error')).toBe(false);
    expect(isCredentialRejection(1006, '')).toBe(false);
  });
});

// ── v2: reliability (R1, R2, R4), access control (A2, A3) and X2 ───────────

import { mkdtempSync, rmSync, existsSync as fileExists } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconnectDelay } from './agent';
import { writeAccess, accessRequestPath, readAccessRequest } from './access';
import { signMessage } from '../shared/crypto';

const SIGNING_KEY = 'test-signing-key';

/** A relay that authenticates, then lets the test push signed messages. */
class FakeRelay extends EventTarget {
  static OPEN = 1;
  static sockets: FakeRelay[] = [];
  readyState = 1;
  sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private nonce = 0;
  constructor(_url: URL) {
    super();
    FakeRelay.sockets.push(this);
    setTimeout(() => this.dispatchEvent(new Event('open')), 1);
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.type === 'auth') this.deliverRaw({ type: 'auth_ok', signingKey: SIGNING_KEY });
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  deliverRaw(msg: unknown) {
    setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(msg) })), 1);
  }
  deliverSigned(msg: Record<string, unknown>) {
    const nonce = ++this.nonce;
    this.deliverRaw({ ...msg, _sig: signMessage(SIGNING_KEY, JSON.stringify(msg), nonce), _nonce: nonce });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
  responses(id: string) {
    return this.sent.filter((m) => m.id === id);
  }
  notifications(method: string) {
    return this.sent.filter((m) => m.method === method);
  }
}

const TEST_CONFIG = {
  apiUrl: 'http://127.0.0.1:9/v1/tunnel',
  token: 'kortix_tnl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  tunnelId: '00000000-0000-4000-8000-000000000001',
};

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return fn().finally(() => {
    process.stdout.write = originalWrite;
  });
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

describe('reconnect backoff (R4)', () => {
  test('doubles from 1 s with ±20 % jitter and never exceeds 30 s', () => {
    expect(reconnectDelay(1, 0.5)).toBe(1_000);
    expect(reconnectDelay(1, 0)).toBe(800);
    expect(reconnectDelay(1, 1)).toBe(1_200);
    expect(reconnectDelay(3, 0.5)).toBe(4_000);
    expect(reconnectDelay(40, 0)).toBe(24_000);
    expect(reconnectDelay(40, 1)).toBe(30_000);
    expect(reconnectDelay(1_000, 0.99)).toBeLessThanOrEqual(30_000);
  });
});

describe('service mode never gives up (R2)', () => {
  test('a refused credential parks the agent in `rejected` and re-probes later', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = closingWebSocket(4001, 'authentication failed') as unknown as typeof WebSocket;
    const Socket = globalThis.WebSocket as unknown as { created: number };
    Socket.created = 0;
    const terminal: string[] = [];
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(
      loadConfig(TEST_CONFIG),
      new CapabilityRegistry(),
      { onStatus: (s) => statuses.push(s), onTerminalClose: (e) => terminal.push(e.reason) },
      { persistent: true, rejectedRetryMs: 60 },
    );
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => Socket.created >= 2);
      } finally {
        agent.disconnect();
      }
    });
    expect(terminal).toEqual([]);
    expect(statuses).toContain('rejected');
  });

  test('a removed computer says so, and names the one command that pairs it again', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = closingWebSocket(4001, 'authentication failed') as unknown as typeof WebSocket;
    const Socket = globalThis.WebSocket as unknown as { created: number };
    Socket.created = 0;
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), {}, { persistent: true, rejectedRetryMs: 60 });
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      agent.connect();
      await until(() => Socket.created >= 2);
    } finally {
      agent.disconnect();
      process.stdout.write = originalWrite;
    }
    const text = output.join('');
    expect(text).toContain('This computer is no longer connected to Kortix');
    expect(text).toContain('npx @kortix/agent-tunnel@latest connect --reauth');
  });

  test('a re-pair while `rejected` reconnects at once, without waiting out the re-probe', async () => {
    globalThis.WebSocket = closingWebSocket(4001, 'authentication failed') as unknown as typeof WebSocket;
    const Socket = globalThis.WebSocket as unknown as { created: number };
    Socket.created = 0;
    const statuses: TunnelAgentStatus[] = [];
    let saved = loadConfig(TEST_CONFIG);
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), { onStatus: (s) => statuses.push(s) }, {
      persistent: true,
      rejectedRetryMs: 60_000,
      watchdogIntervalMs: 20,
      reloadConfig: () => saved,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-repair-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => statuses.includes('rejected'));
        await Bun.sleep(100);
        expect(Socket.created).toBe(1); // the same credential is not retried early
        saved = loadConfig({ ...TEST_CONFIG, tunnelId: '00000000-0000-4000-8000-000000000002' });
        await until(() => Socket.created >= 2, 1_000);
      } finally {
        agent.disconnect();
      }
    });
  });

  test('a replaced agent waits in `standby` and tries again', async () => {
    globalThis.WebSocket = closingWebSocket(4004, 'replaced') as unknown as typeof WebSocket;
    const Socket = globalThis.WebSocket as unknown as { created: number };
    Socket.created = 0;
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(
      loadConfig(TEST_CONFIG),
      new CapabilityRegistry(),
      { onStatus: (s) => statuses.push(s) },
      { persistent: true, standbyRetryMs: 60 },
    );
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => Socket.created >= 2);
      } finally {
        agent.disconnect();
      }
    });
    expect(statuses).toContain('standby');
  });
});

describe('liveness watchdog (R1)', () => {
  test('no relay ping for the liveness window closes the socket with 4000 and reconnects', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), { onStatus: (s) => statuses.push(s) }, {
      livenessTimeoutMs: 150,
      watchdogIntervalMs: 20,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-watchdog-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => statuses.includes('online'));
        await until(() => FakeRelay.sockets.length >= 2, 4_000);
      } finally {
        agent.disconnect();
      }
    });
    expect(FakeRelay.sockets[0]!.closedWith).toEqual({ code: 4000, reason: 'liveness timeout' });
  });

  test('pings keep the connection; a wall-clock jump (sleep/wake) forces a reconnect', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    let clock = Date.now();
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), { onStatus: (s) => statuses.push(s) }, {
      livenessTimeoutMs: 10_000,
      watchdogIntervalMs: 20,
      now: () => clock,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-watchdog-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => statuses.includes('online'));
        FakeRelay.sockets[0]!.deliverSigned({ jsonrpc: '2.0', method: 'tunnel.ping', params: {} });
        await until(() => FakeRelay.sockets[0]!.notifications('tunnel.pong').length === 1);
        await Bun.sleep(100);
        expect(FakeRelay.sockets).toHaveLength(1);
        clock += 60_000; // the machine slept for a minute
        await until(() => FakeRelay.sockets.length >= 2, 4_000);
      } finally {
        agent.disconnect();
      }
    });
    expect(FakeRelay.sockets[0]!.closedWith?.code).toBe(4000);
  });

  test('after a sleep the agent reconnects at once, whatever backoff it had built up before', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    let clock = Date.now();
    const statuses: TunnelAgentStatus[] = [];
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), { onStatus: (s) => statuses.push(s) }, {
      livenessTimeoutMs: 10_000,
      watchdogIntervalMs: 20,
      now: () => clock,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-watchdog-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => statuses.includes('online'));
        // Flapping before the sleep left the backoff at its 30 s cap.
        (agent as unknown as { reconnectAttempts: number }).reconnectAttempts = 12;
        clock += 120_000;
        await until(() => FakeRelay.sockets.length >= 2, 2_000);
      } finally {
        agent.disconnect();
      }
    });
  });
});

describe('machine-side access control (A2, A3, X1, X2)', () => {
  function accessAgent(home: string, holdMs = 200) {
    const registry = new CapabilityRegistry();
    registry.register({
      name: 'filesystem',
      methods: new Map([['fs.stat', async () => ({ ok: true })]]),
    } as any);
    return new TunnelAgent(loadConfig(TEST_CONFIG), registry, {}, { home, accessHoldMs: holdMs, watchdogIntervalMs: 20 });
  }

  async function withOnlineAgent(home: string, run: (relay: FakeRelay) => Promise<void>, holdMs?: number) {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    const agent = accessAgent(home, holdMs);
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => FakeRelay.sockets[0]?.sent.some((m) => m.type === 'auth') === true);
        const relay = FakeRelay.sockets[0]!;
        relay.deliverSigned({
          jsonrpc: '2.0',
          method: 'tunnel.permissions.sync',
          params: { permissions: [{ permissionId: 'perm-fs', capability: 'filesystem', scope: {} }] },
        });
        await Bun.sleep(20);
        await run(relay);
      } finally {
        agent.disconnect();
      }
    });
  }

  const call = (relay: FakeRelay, id: string) =>
    relay.deliverSigned({ jsonrpc: '2.0', id, method: 'fs.stat', params: { permissionId: 'perm-fs', path: '/' } });

  test('always runs the call; off refuses it with -32012', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
    try {
      writeAccess({ mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
      await withOnlineAgent(home, async (relay) => {
        call(relay, 'r1');
        await until(() => relay.responses('r1').length === 1);
        expect(relay.responses('r1')[0].result).toEqual({ ok: true });

        writeAccess({ mode: 'off', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
        call(relay, 'r2');
        await until(() => relay.responses('r2').length === 1);
        expect(relay.responses('r2')[0].error.code).toBe(-32012);
        expect(relay.responses('r2')[0].error.message).toStartWith('computer_access_off:');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ask with no answer holds the call, writes a request, then returns -32010', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
    try {
      writeAccess({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
      await withOnlineAgent(home, async (relay) => {
        const started = Date.now();
        call(relay, 'r1');
        await until(() => fileExists(accessRequestPath(home)));
        await until(() => relay.responses('r1').length === 1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(180);
        expect(relay.responses('r1')[0].error.code).toBe(-32010);
        expect(relay.responses('r1')[0].error.message).toStartWith('computer_access_pending:');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ask: a grant given during the hold runs the held call', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
    try {
      writeAccess({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
      await withOnlineAgent(
        home,
        async (relay) => {
          call(relay, 'r1');
          await until(() => fileExists(accessRequestPath(home)));
          writeAccess(
            { mode: 'ask', grantedUntil: new Date(Date.now() + 3_600_000).toISOString(), deniedUntil: null, keepAwake: false },
            home,
          );
          await until(() => relay.responses('r1').length === 1);
          expect(relay.responses('r1')[0].result).toEqual({ ok: true });
          expect(fileExists(accessRequestPath(home))).toBe(false);
        },
        5_000,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ask: a denial fails the held call with -32011, and later calls fail fast', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
    try {
      writeAccess({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
      await withOnlineAgent(
        home,
        async (relay) => {
          call(relay, 'r1');
          await until(() => fileExists(accessRequestPath(home)));
          writeAccess(
            { mode: 'ask', grantedUntil: null, deniedUntil: new Date(Date.now() + 600_000).toISOString(), keepAwake: false },
            home,
          );
          await until(() => relay.responses('r1').length === 1);
          expect(relay.responses('r1')[0].error.code).toBe(-32011);
          const started = Date.now();
          call(relay, 'r2');
          await until(() => relay.responses('r2').length === 1);
          expect(relay.responses('r2')[0].error.code).toBe(-32011);
          expect(Date.now() - started).toBeLessThan(1_000);
        },
        5_000,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reports the access state to the relay on connect and on every change', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
    try {
      writeAccess({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
      await withOnlineAgent(home, async (relay) => {
        await until(() => relay.notifications('tunnel.access.state').length === 1);
        expect(relay.notifications('tunnel.access.state')[0].params).toEqual({ mode: 'ask', grantedUntil: null });
        expect(typeof relay.notifications('tunnel.access.state')[0]._sig).toBe('string');
        writeAccess({ mode: 'off', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
        await until(() => relay.notifications('tunnel.access.state').length === 2);
        expect(relay.notifications('tunnel.access.state')[1].params).toEqual({ mode: 'off', grantedUntil: null });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('contract v2 review fixes', () => {
  test('standby backs off, doubling, so two holders of one credential stop trading the socket', async () => {
    globalThis.WebSocket = closingWebSocket(4004, 'replaced') as unknown as typeof WebSocket;
    const Socket = globalThis.WebSocket as unknown as { created: number };
    Socket.created = 0;
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), {}, { persistent: true, standbyRetryMs: 40 });
    await quiet(async () => {
      try {
        agent.connect();
        await Bun.sleep(400);
      } finally {
        agent.disconnect();
      }
    });
    // A fixed 40 ms retry would open about 10 sockets; 40, 80, 160 ms opens 4.
    expect(Socket.created).toBeGreaterThanOrEqual(3);
    expect(Socket.created).toBeLessThanOrEqual(5);
  });

  test('a handshake that never reaches auth_ok is dropped and retried', async () => {
    class SilentRelay extends EventTarget {
      static OPEN = 1;
      static created = 0;
      readyState = 1;
      closedWith: number | undefined;
      constructor(_url: URL) {
        super();
        SilentRelay.created++;
        setTimeout(() => this.dispatchEvent(new Event('open')), 1);
      }
      send() {}
      close(code?: number) { this.closedWith = code; }
    }
    globalThis.WebSocket = SilentRelay as unknown as typeof WebSocket;
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), {}, {
      connectDeadlineMs: 100,
      watchdogIntervalMs: 20,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-handshake-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => SilentRelay.created >= 2, 3_000);
      } finally {
        agent.disconnect();
      }
    });
  });

  test('onStatus names the credential in use, so state.json follows a re-pair', async () => {
    globalThis.WebSocket = closingWebSocket(4001, 'authentication failed') as unknown as typeof WebSocket;
    const seen: string[] = [];
    let saved = loadConfig(TEST_CONFIG);
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), {
      onStatus: (status, config) => seen.push(`${status}:${config.tunnelId.slice(-1)}`),
    }, {
      persistent: true,
      rejectedRetryMs: 60_000,
      watchdogIntervalMs: 20,
      reloadConfig: () => saved,
      home: mkdtempSync(join(tmpdir(), 'agent-tunnel-state-')),
    });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => seen.includes('rejected:1'));
        saved = loadConfig({ ...TEST_CONFIG, tunnelId: '00000000-0000-4000-8000-000000000002' });
        await until(() => seen.includes('connecting:2'), 1_000);
      } finally {
        agent.disconnect();
      }
    });
  });

  test('a lapsed grant is reported as no grant', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-lapse-'));
    const grant = new Date(Date.now() + 300).toISOString();
    writeAccess({ mode: 'ask', grantedUntil: grant, deniedUntil: null, keepAwake: false }, home);
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), new CapabilityRegistry(), {}, { home, watchdogIntervalMs: 20 });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => FakeRelay.sockets[0]?.notifications('tunnel.access.state').length === 1);
        expect(FakeRelay.sockets[0]!.notifications('tunnel.access.state')[0].params).toEqual({ mode: 'ask', grantedUntil: grant });
        await until(() => FakeRelay.sockets[0]!.notifications('tunnel.access.state').length === 2, 2_000);
        expect(FakeRelay.sockets[0]!.notifications('tunnel.access.state')[1].params).toEqual({ mode: 'ask', grantedUntil: null });
      } finally {
        agent.disconnect();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  test('concurrent ask-mode calls share one pending request (one prompt, one app launch)', async () => {
    FakeRelay.sockets = [];
    globalThis.WebSocket = FakeRelay as unknown as typeof WebSocket;
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-shared-request-'));
    writeAccess({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false }, home);
    const registry = new CapabilityRegistry();
    registry.register({ name: 'filesystem', methods: new Map([['fs.stat', async () => ({ ok: true })]]) } as any);
    const agent = new TunnelAgent(loadConfig(TEST_CONFIG), registry, {}, { home, accessHoldMs: 500, watchdogIntervalMs: 20 });
    await quiet(async () => {
      try {
        agent.connect();
        await until(() => FakeRelay.sockets[0]?.sent.some((m) => m.type === 'auth') === true);
        const relay = FakeRelay.sockets[0]!;
        relay.deliverSigned({ jsonrpc: '2.0', method: 'tunnel.permissions.sync', params: { permissions: [{ permissionId: 'perm-fs', capability: 'filesystem', scope: {} }] } });
        await Bun.sleep(20);
        relay.deliverSigned({ jsonrpc: '2.0', id: 'a', method: 'fs.stat', params: { permissionId: 'perm-fs', path: '/' } });
        await until(() => readAccessRequest(home) !== null);
        const first = readAccessRequest(home)!.id;
        relay.deliverSigned({ jsonrpc: '2.0', id: 'b', method: 'fs.stat', params: { permissionId: 'perm-fs', path: '/' } });
        await Bun.sleep(100);
        expect(readAccessRequest(home)!.id).toBe(first);
        await until(() => relay.responses('b').length === 1, 2_000);
      } finally {
        agent.disconnect();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
