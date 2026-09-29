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
