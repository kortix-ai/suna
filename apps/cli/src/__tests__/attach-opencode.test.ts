import { describe, expect, test } from 'bun:test';

import type { RunningSandboxPortProxy } from '../api/sdk.ts';
import {
  ATTACH_UNSUPPORTED,
  AttachOpenCodeError,
  type AttachOpenCodeDeps,
  attachOpenCodeSession,
} from '../attach-opencode.ts';
import type { SessionRuntime } from '../session-runtime.ts';
import { auth, session } from './support/attach-fixtures.ts';

const OPENCODE_SESSION_ID = 'ses_opencode';

function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    session,
    auth,
    handle: {} as SessionRuntime['handle'],
    runtimeUrl: 'https://runtime.example.test/p/ext/8000',
    runtimeSessionId: OPENCODE_SESSION_ID,
    ...overrides,
  };
}

interface Harness {
  deps: AttachOpenCodeDeps;
  /** Every `startProxy` result handed out, with its close state. */
  proxies: Array<{ url: string; closed: boolean }>;
  binRequests: Array<{ version?: string }>;
  spawned: Array<{ bin: string; args: string[] }>;
}

function harness(overrides: { probeCapabilities?: AttachOpenCodeDeps['probeCapabilities'] } = {}): Harness {
  const proxies: Harness['proxies'] = [];
  const binRequests: Array<{ version?: string }> = [];
  const spawned: Array<{ bin: string; args: string[] }> = [];

  const deps: AttachOpenCodeDeps = {
    resolveRuntime: async () => runtimeFor(),
    probeCapabilities: overrides.probeCapabilities ?? (async () => undefined),
    probeRuntimeVersion: async () => '1.18.23',
    ensureBin: async (options) => {
      binRequests.push(options);
      return { bin: '/managed/opencode' };
    },
    startProxy: () => {
      const record = { url: 'http://127.0.0.1:41234', closed: false };
      proxies.push(record);
      const proxy: RunningSandboxPortProxy = {
        url: record.url,
        close: () => {
          record.closed = true;
        },
      };
      return proxy;
    },
    spawnAttach: async (bin, args) => {
      spawned.push({ bin, args });
      return 0;
    },
  };
  return { deps, proxies, binRequests, spawned };
}

describe('attachOpenCodeSession', () => {
  test('a runtime without session.attach is refused before the binary or proxy is touched', async () => {
    const h = harness({ probeCapabilities: async () => ['file.import', 'session.subagents'] });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err).toBeInstanceOf(AttachOpenCodeError);
    expect(err.stage).toBe('resolving');
    expect(err.message).toBe(ATTACH_UNSUPPORTED);
    expect(h.binRequests).toEqual([]);
    expect(h.proxies).toEqual([]);
    expect(h.spawned).toEqual([]);
  });
});
