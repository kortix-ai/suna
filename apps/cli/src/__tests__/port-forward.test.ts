import { describe, expect, test } from 'bun:test';

import type { RunningSandboxPortProxy } from '../api/sdk.ts';
import {
  type PortForwardDeps,
  PortForwardError,
  type PortForwardResolveRequest,
  startPortForward,
} from '../port-forward.ts';
import { type SessionRuntime, SessionRuntimeError } from '../session-runtime.ts';
import { auth, session } from './support/attach-fixtures.ts';

function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    session,
    auth,
    handle: {
      sandboxPortUrl: (port: number) => `https://runtime.example.test/p/ext/${port}`,
    } as unknown as SessionRuntime['handle'],
    runtimeUrl: 'https://runtime.example.test/p/ext/8000',
    runtimeSessionId: 'ses_opencode',
    ...overrides,
  };
}

interface Harness {
  deps: PortForwardDeps;
  resolveRequests: PortForwardResolveRequest[];
  startCalls: Array<{ runtimeUrl: string; token: string; port?: number }>;
  proxies: Array<{ url: string; closed: boolean }>;
  portFreeChecks: number[];
}

function harness(
  overrides: {
    resolveRuntime?: PortForwardDeps['resolveRuntime'];
    startProxy?: PortForwardDeps['startProxy'];
    isPortFree?: PortForwardDeps['isPortFree'];
    proxyPortOverride?: (requestedPort: number | undefined, sandboxPort: number) => number;
  } = {},
): Harness {
  const resolveRequests: PortForwardResolveRequest[] = [];
  const startCalls: Harness['startCalls'] = [];
  const proxies: Harness['proxies'] = [];
  const portFreeChecks: number[] = [];

  const deps: PortForwardDeps = {
    resolveRuntime:
      overrides.resolveRuntime ??
      (async (request) => {
        resolveRequests.push(request);
        return runtimeFor();
      }),
    startProxy:
      overrides.startProxy ??
      ((options) => {
        startCalls.push(options);
        const boundPort = overrides.proxyPortOverride
          ? overrides.proxyPortOverride(options.port, options.port ?? 0)
          : (options.port ?? 41999);
        const record = { url: `http://127.0.0.1:${boundPort}`, closed: false };
        proxies.push(record);
        const proxy: RunningSandboxPortProxy = {
          url: record.url,
          close: () => {
            record.closed = true;
          },
        };
        return proxy;
      }),
    isPortFree:
      overrides.isPortFree ??
      (async (port) => {
        portFreeChecks.push(port);
        return true;
      }),
  };
  return { deps, resolveRequests, startCalls, proxies, portFreeChecks };
}

describe('startPortForward', () => {
  test('forwards a single port to the same local port by default', async () => {
    const h = harness();
    const result = await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000 }],
      deps: h.deps,
    });

    expect(result.forwards).toHaveLength(1);
    expect(result.forwards[0]).toMatchObject({ sandboxPort: 3000, localPort: 3000 });
    expect(h.startCalls[0]).toMatchObject({
      runtimeUrl: 'https://runtime.example.test/p/ext/3000',
      token: auth.token,
      port: 3000,
    });
    result.close();
    expect(h.proxies[0]?.closed).toBe(true);
  });

  test('honors an explicit local port ("--port 3000:4000")', async () => {
    const h = harness();
    const result = await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000, localPort: 4000 }],
      deps: h.deps,
    });

    expect(result.forwards[0]).toMatchObject({ sandboxPort: 3000, localPort: 4000 });
    expect(h.startCalls[0]?.port).toBe(4000);
    // An explicit local port is used as-is — never probed for availability.
    expect(h.portFreeChecks).toEqual([]);
  });

  test('picks the next free local port when the default one is taken', async () => {
    const h = harness({
      isPortFree: async (port) => port !== 3000,
    });
    const result = await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000 }],
      deps: h.deps,
    });

    expect(result.forwards[0]?.localPort).toBe(3001);
    expect(h.startCalls[0]?.port).toBe(3001);
  });

  test('localPort: 0 requests an OS-assigned ephemeral port without probing availability', async () => {
    const h = harness({ proxyPortOverride: () => 54321 });
    const result = await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000, localPort: 0 }],
      deps: h.deps,
    });

    expect(h.startCalls[0]?.port).toBe(0);
    expect(h.portFreeChecks).toEqual([]);
    // The actually-bound ephemeral port is read back from the proxy's URL.
    expect(result.forwards[0]?.localPort).toBe(54321);
  });

  test('forwards several ports independently in one call', async () => {
    const h = harness();
    const result = await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000 }, { sandboxPort: 5173, localPort: 5174 }],
      deps: h.deps,
    });

    expect(
      result.forwards.map(({ sandboxPort, localPort, url }) => ({ sandboxPort, localPort, url })),
    ).toEqual([
      { sandboxPort: 3000, localPort: 3000, url: 'http://127.0.0.1:3000' },
      { sandboxPort: 5173, localPort: 5174, url: 'http://127.0.0.1:5174' },
    ]);
  });

  test('closes every already-opened proxy when a later port fails to start', async () => {
    let calls = 0;
    const h = harness({
      startProxy: (options) => {
        calls += 1;
        if (calls === 2) throw new Error('EADDRINUSE');
        const proxy: RunningSandboxPortProxy = {
          url: `http://127.0.0.1:${options.port}`,
          close: () => {},
        };
        return proxy;
      },
    });
    const closedFlags: boolean[] = [];
    const trackedStart: PortForwardDeps['startProxy'] = (options) => {
      const proxy = h.deps.startProxy?.(options) as RunningSandboxPortProxy;
      const original = proxy.close;
      let closed = false;
      closedFlags.push(false);
      const index = closedFlags.length - 1;
      return {
        url: proxy.url,
        close: () => {
          closed = true;
          closedFlags[index] = closed;
          original();
        },
      };
    };

    await expect(
      startPortForward({
        auth,
        projectId: 'proj',
        sessionId: session.session_id,
        forwards: [{ sandboxPort: 3000 }, { sandboxPort: 5173 }],
        deps: { ...h.deps, startProxy: trackedStart },
      }),
    ).rejects.toThrow(PortForwardError);

    expect(closedFlags).toEqual([true]);
  });

  test('rejects with no forwards given, before resolving the session', async () => {
    const h = harness();
    await expect(
      startPortForward({
        auth,
        projectId: 'proj',
        sessionId: session.session_id,
        forwards: [],
        deps: h.deps,
      }),
    ).rejects.toThrow(/pass at least one/i);
    expect(h.resolveRequests).toHaveLength(0);
  });

  test('surfaces a stopped session as PortForwardError without attempting to restart it', async () => {
    const h = harness({
      resolveRuntime: async () => {
        throw new SessionRuntimeError(
          'not-running',
          `Session ${session.session_id} is stopped, not running.`,
        );
      },
    });

    let caught: unknown;
    try {
      await startPortForward({
        auth,
        projectId: 'proj',
        sessionId: session.session_id,
        forwards: [{ sandboxPort: 3000 }],
        deps: h.deps,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PortForwardError);
    expect((caught as PortForwardError).stage).toBe('resolving');
    expect((caught as PortForwardError).cause).toBeInstanceOf(SessionRuntimeError);
    expect(((caught as PortForwardError).cause as SessionRuntimeError).kind).toBe('not-running');
  });

  test('calls onStatus for resolving and each forwarded port', async () => {
    const h = harness();
    const stages: string[] = [];
    await startPortForward({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      forwards: [{ sandboxPort: 3000 }],
      deps: h.deps,
      onStatus: (stage) => stages.push(stage),
    });

    expect(stages).toEqual(['resolving', 'forwarding']);
  });
});
