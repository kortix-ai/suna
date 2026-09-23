import type { ChildProcess } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

import type { RunningOpenCodeProxy } from '../api/sdk.ts';
import {
  AttachOpenCodeError,
  type AttachOpenCodeDeps,
  type AttachResolveRequest,
  type AttachStage,
  attachOpenCodeSession,
  attachSessionLabel,
  buildAttachArgs,
} from '../attach-opencode.ts';
import type { SessionRuntime, SessionRuntimeFailure } from '../session-runtime.ts';
import { SessionRuntimeError } from '../session-runtime.ts';
import { auth, session } from './support/attach-fixtures.ts';

const OPENCODE_SESSION_ID = 'ses_opencode';

function runtimeFor(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    session,
    auth,
    handle: {} as SessionRuntime['handle'],
    runtime: {} as SessionRuntime['runtime'],
    runtimeUrl: 'https://runtime.example.test/p/ext/8000',
    opencodeSessionId: OPENCODE_SESSION_ID,
    ...overrides,
  };
}

interface Harness {
  deps: AttachOpenCodeDeps;
  /** Every `startProxy` result handed out, with its close state. */
  proxies: Array<{ url: string; closed: boolean }>;
  resolveRequests: AttachResolveRequest[];
  binRequests: Array<{ version?: string }>;
  spawned: Array<{ bin: string; args: string[] }>;
  /** Proxy close state observed at the moment the child was spawned. */
  closedDuringSpawn: boolean[];
}

function harness(
  overrides: {
    resolveRuntime?: AttachOpenCodeDeps['resolveRuntime'];
    ensureBin?: AttachOpenCodeDeps['ensureBin'];
    startProxy?: AttachOpenCodeDeps['startProxy'];
    spawnAttach?: AttachOpenCodeDeps['spawnAttach'];
    exitCode?: number;
  } = {},
): Harness {
  const proxies: Harness['proxies'] = [];
  const resolveRequests: AttachResolveRequest[] = [];
  const binRequests: Array<{ version?: string }> = [];
  const spawned: Array<{ bin: string; args: string[] }> = [];
  const closedDuringSpawn: boolean[] = [];

  const deps: AttachOpenCodeDeps = {
    resolveRuntime:
      overrides.resolveRuntime ??
      (async (request) => {
        resolveRequests.push(request);
        return runtimeFor();
      }),
    probeRuntimeVersion: async () => '1.18.23',
    ensureBin:
      overrides.ensureBin ??
      (async (options) => {
        binRequests.push(options);
        return { bin: '/managed/opencode' };
      }),
    startProxy:
      overrides.startProxy ??
      (() => {
        const record = { url: 'http://127.0.0.1:41234', closed: false };
        proxies.push(record);
        const proxy: RunningOpenCodeProxy = {
          url: record.url,
          close: () => {
            record.closed = true;
          },
        };
        return proxy;
      }),
    spawnAttach:
      overrides.spawnAttach ??
      (async (bin, args) => {
        spawned.push({ bin, args });
        closedDuringSpawn.push(proxies.some((p) => p.closed));
        return overrides.exitCode ?? 0;
      }),
  };
  return { deps, proxies, resolveRequests, binRequests, spawned, closedDuringSpawn };
}

describe('buildAttachArgs', () => {
  test('injects --session when no continuation flag was passed', () => {
    expect(buildAttachArgs('http://127.0.0.1:1', 'ses_x', [])).toEqual([
      'attach',
      'http://127.0.0.1:1',
      '--session',
      'ses_x',
    ]);
  });

  test('extra args are appended after the injected --session', () => {
    expect(buildAttachArgs('http://127.0.0.1:1', 'ses_x', ['--mini'])).toEqual([
      'attach',
      'http://127.0.0.1:1',
      '--session',
      'ses_x',
      '--mini',
    ]);
  });

  test.each([['--session'], ['-s'], ['--session=other'], ['--continue'], ['-c']])(
    'a caller-supplied %s suppresses the injected --session',
    (flag) => {
      expect(buildAttachArgs('http://127.0.0.1:1', 'ses_x', [flag, 'tail'])).toEqual([
        'attach',
        'http://127.0.0.1:1',
        flag,
        'tail',
      ]);
    },
  );
});

describe('attachSessionLabel', () => {
  test('prefers the session name, else the short id', () => {
    expect(attachSessionLabel(session)).toBe('Fix the thing');
    expect(attachSessionLabel({ ...session, name: null })).toBe('abcd1234');
  });
});

describe('attachOpenCodeSession', () => {
  test('emits the happy-path status sequence and returns the child exit code', async () => {
    const h = harness({ exitCode: 7 });
    const stages: AttachStage[] = [];
    let attachedDetail = '';
    let attachedContext: Record<string, unknown> = {};

    const result = await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      onStatus: (stage, detail, context) => {
        stages.push(stage);
        if (stage === 'attached') {
          attachedDetail = detail;
          attachedContext = context as unknown as Record<string, unknown>;
        }
      },
      deps: h.deps,
    });

    expect(stages).toEqual(['resolving', 'downloading-binary', 'proxy-ready', 'attached']);
    expect(result).toEqual({
      exitCode: 7,
      opencodeSessionId: OPENCODE_SESSION_ID,
      proxyUrl: 'http://127.0.0.1:41234',
    });
    expect(attachedDetail).toBe(
      'Connecting to Fix the thing (OpenCode ses_opencode, local http://127.0.0.1:41234)',
    );
    expect(attachedContext).toMatchObject({
      opencodeSessionId: OPENCODE_SESSION_ID,
      proxyUrl: 'http://127.0.0.1:41234',
    });
    expect(h.spawned).toEqual([
      {
        bin: '/managed/opencode',
        args: ['attach', 'http://127.0.0.1:41234', '--session', OPENCODE_SESSION_ID],
      },
    ]);
    // The version-matched binary is resolved BEFORE the proxy opens.
    expect(h.binRequests).toEqual([{ version: '1.18.23' }]);
  });

  test("a session that has to boot emits 'restarting' between resolve and download", async () => {
    const h = harness({
      resolveRuntime: async (request) => {
        request.onStarting({ ...session, status: 'stopped' });
        return runtimeFor();
      },
    });
    const stages: AttachStage[] = [];
    await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      onStatus: (stage) => stages.push(stage),
      deps: h.deps,
    });
    expect(stages).toEqual([
      'resolving',
      'restarting',
      'downloading-binary',
      'proxy-ready',
      'attached',
    ]);
  });

  test('restartDormant defaults to true and is forwarded to the resolver', async () => {
    const h = harness();
    await attachOpenCodeSession({ auth, projectId: 'proj', sessionId: 'sess', deps: h.deps });
    expect(h.resolveRequests[0]).toMatchObject({
      projectId: 'proj',
      sessionId: 'sess',
      restartDormant: true,
    });

    const strict = harness();
    await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      restartDormant: false,
      session,
      deps: strict.deps,
    });
    expect(strict.resolveRequests[0]).toMatchObject({ restartDormant: false, session });
  });

  test('extraArgs reach the spawned command', async () => {
    const h = harness();
    await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      extraArgs: ['--mini'],
      deps: h.deps,
    });
    expect(h.spawned[0]?.args).toEqual([
      'attach',
      'http://127.0.0.1:41234',
      '--session',
      OPENCODE_SESSION_ID,
      '--mini',
    ]);
  });

  test('the proxy port the caller asked for is passed through', async () => {
    const ports: Array<number | undefined> = [];
    const h = harness({
      startProxy: (options) => {
        ports.push(options.port);
        return { url: 'http://127.0.0.1:4100', close: () => {} };
      },
    });
    await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      proxyPort: 4100,
      deps: h.deps,
    });
    expect(ports).toEqual([4100]);
  });

  test('the proxy is closed after the child exits', async () => {
    const h = harness();
    await attachOpenCodeSession({ auth, projectId: 'proj', sessionId: 'sess', deps: h.deps });
    expect(h.closedDuringSpawn).toEqual([false]);
    expect(h.proxies).toEqual([{ url: 'http://127.0.0.1:41234', closed: true }]);
  });

  test('the proxy is closed when the child could not be spawned', async () => {
    const h = harness({
      spawnAttach: async () => {
        throw new Error('Could not run /managed/opencode: ENOENT');
      },
    });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err).toBeInstanceOf(AttachOpenCodeError);
    expect(err.stage).toBe('attached');
    expect(err.message).toBe('Could not run /managed/opencode: ENOENT');
    expect(h.proxies[0]?.closed).toBe(true);
  });

  test('a binary download failure fails at stage downloading-binary, before any proxy', async () => {
    const h = harness({
      ensureBin: async () => {
        throw new Error('Could not download OpenCode v1.18.23: offline');
      },
    });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err).toBeInstanceOf(AttachOpenCodeError);
    expect(err.stage).toBe('downloading-binary');
    expect(err.message).toBe('Could not download OpenCode v1.18.23: offline');
    expect(h.proxies).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  test('a proxy that cannot listen fails at stage proxy-ready', async () => {
    const h = harness({
      startProxy: () => {
        throw new Error('EADDRINUSE: address already in use');
      },
    });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err.stage).toBe('proxy-ready');
    expect(err.message).toBe('EADDRINUSE: address already in use');
    expect(h.spawned).toEqual([]);
  });

  test('a not-running session surfaces as stage resolving with the SessionRuntimeError as cause', async () => {
    const failure = new SessionRuntimeError(
      'not-running',
      `Session ${session.session_id} is stopped, not running.`,
    );
    const h = harness({
      resolveRuntime: async () => {
        throw failure;
      },
    });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: session.session_id,
      restartDormant: false,
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err.stage).toBe('resolving');
    expect(err.cause).toBe(failure);
    expect(err.message).toBe(`Session ${session.session_id} is stopped, not running.`);
  });

  test.each([
    ['start-failed', 'restarting'],
    ['timeout', 'restarting'],
    ['ensure-ready', 'resolving'],
    ['api', 'resolving'],
  ] as Array<[SessionRuntimeFailure, AttachStage]>)(
    'a %s failure maps to stage %s',
    async (kind, stage) => {
      const h = harness({
        resolveRuntime: async () => {
          throw new SessionRuntimeError(kind, 'boom');
        },
      });
      const err = (await attachOpenCodeSession({
        auth,
        projectId: 'proj',
        sessionId: 'sess',
        deps: h.deps,
      }).catch((e) => e)) as AttachOpenCodeError;
      expect(err.stage).toBe(stage);
    },
  );

  test('onChild receives the spawned process', async () => {
    const child = { pid: 4242 } as ChildProcess;
    const h = harness({
      spawnAttach: async (_bin, _args, onChild) => {
        onChild?.(child);
        return 0;
      },
    });
    const seen: ChildProcess[] = [];
    await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      onChild: (c) => seen.push(c),
      deps: h.deps,
    });
    expect(seen).toEqual([child]);
  });

  test('a session with no OpenCode id is refused before the binary is touched', async () => {
    const h = harness({
      resolveRuntime: async () => runtimeFor({ opencodeSessionId: '' }),
    });
    const err = (await attachOpenCodeSession({
      auth,
      projectId: 'proj',
      sessionId: 'sess',
      deps: h.deps,
    }).catch((e) => e)) as AttachOpenCodeError;
    expect(err.stage).toBe('resolving');
    expect(h.binRequests).toEqual([]);
  });
});
