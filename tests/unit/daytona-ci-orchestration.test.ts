import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DAYTONA_CI_SNAPSHOT_VERSION,
  DaytonaHttpError,
  type DaytonaCiInput,
  type DaytonaSandbox,
  type DaytonaSnapshot,
  ensureWarmSnapshot,
  waitForSandbox,
} from '../src/core/daytona-ci';

/**
 * Characterization tests for the Daytona warm-snapshot orchestration and the
 * state-poll loops (KRTX-1432). They pin the CURRENT behavior — cache reuse,
 * failed-snapshot replacement, the warm-builder ownership loop, the
 * upload/launch/observe ceremony, the marker, the snapshot capture, the
 * finally-deletion, and the terminal-state/timeout contracts of the poll
 * loops — so the behavior-preserving refactor is judged against exactly what
 * these tests saw before it.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeSnapshot extends DaytonaSnapshot {
  createdAtCall: number;
}

interface FakeSandbox extends DaytonaSandbox {
  createdAtCall: number;
}

/**
 * The remote builder "filesystem" the execute-command probes read and write,
 * so the fake answers the upload/launch/cat/stat/dd/marker commands the way
 * the real toolbox would.
 */
class RemoteBox {
  files = new Map<string, string>();
  uploads: string[] = [];
  launches: string[] = [];
  warmExitCode: string | null = null;
  markerValid = true;
  uploadFails = false;

  execute(command: string): { exitCode: number; result: string } {
    // Upload: `printf %s <base64> | base64 -d > <path> && chmod 0755 <path>`
    const upload = command.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d > (\S+)/);
    if (upload) {
      if (this.uploadFails) return { exitCode: 1, result: 'toolbox refused' };
      this.files.set(upload[2]!, Buffer.from(upload[1]!, 'base64').toString('utf8'));
      this.uploads.push(upload[2]!);
      return { exitCode: 0, result: '' };
    }
    if (command.includes('setsid -f /workspace/prepare-daytona-warm.sh')) {
      this.launches.push(command);
      this.files.set('/workspace/daytona-warm.exit', this.warmExitCode ?? '0');
      this.files.set('/workspace/daytona-warm.log', 'warm preparation ran');
      return { exitCode: 0, result: '' };
    }
    if (command.startsWith('if [[ -f /workspace/daytona-warm.exit ]]')) {
      const content = this.files.get('/workspace/daytona-warm.exit');
      if (content === undefined) return { exitCode: 3, result: '' };
      return { exitCode: 0, result: content };
    }
    if (command.startsWith('if [[ -f /workspace/daytona-warm.log ]]')) {
      const content = this.files.get('/workspace/daytona-warm.log');
      if (content === undefined) return { exitCode: 3, result: '' };
      return { exitCode: 0, result: String(content.length) };
    }
    if (command.startsWith('dd if=/workspace/daytona-warm.log')) {
      return {
        exitCode: 0,
        result: Buffer.from(this.files.get('/workspace/daytona-warm.log') ?? '').toString('base64'),
      };
    }
    if (command.includes('test -s /workspace/.kortix-ci-warm-ready')) {
      const marker = this.files.get('/workspace/.kortix-ci-warm-ready');
      if (this.markerValid && marker) return { exitCode: 0, result: marker };
      return { exitCode: 1, result: '' };
    }
    return { exitCode: 0, result: '' };
  }
}

/**
 * A stateful fake of the Daytona REST surface ensureWarmSnapshot walks:
 * snapshot/sandbox records with queued state transitions (popped on each
 * GET-by-id), a lookup script queue per name, and the builder's remote box.
 */
class FakeDaytona {
  calls: Call[] = [];
  snapshots = new Map<string, FakeSnapshot>();
  sandboxes = new Map<string, FakeSandbox>();
  box = new RemoteBox();
  private callCount = 0;
  /** Per-name queue of item lists; each findSnapshot(name) call pops one. */
  private lookupScripts = new Map<string, Array<() => FakeSnapshot[]>>();
  /** Per-sandbox-name queue of states, popped on each GET of that sandbox. */
  private sandboxStateQueues = new Map<string, string[]>();
  /** Per-snapshot-name queue of states, popped on each GET of that snapshot. */
  private snapshotStateQueues = new Map<string, string[]>();
  lastSnapshotCreate: Call | undefined;
  lastSandboxCreate: Call | undefined;
  lastCapture: Call | undefined;

  /** Queue what the next findSnapshot(name) calls return (empty list = miss). */
  queueLookup(name: string, ...providers: Array<() => FakeSnapshot[]>): void {
    this.lookupScripts.set(name, [...(this.lookupScripts.get(name) ?? []), ...providers]);
  }

  /** Queue the states a snapshot reports on successive GET-by-id calls. */
  queueSnapshotStates(name: string, ...states: string[]): void {
    this.snapshotStateQueues.set(name, [
      ...(this.snapshotStateQueues.get(name) ?? []),
      ...states,
    ]);
  }

  /** Queue the states a sandbox reports on successive GET-by-id calls. */
  queueSandboxStates(name: string, ...states: string[]): void {
    this.sandboxStateQueues.set(name, [
      ...(this.sandboxStateQueues.get(name) ?? []),
      ...states,
    ]);
  }

  private call(method: string, path: string, body?: unknown): void {
    this.callCount += 1;
    this.calls.push({ method, path, body });
  }

  private advanceSnapshotState(name: string, current: string): string {
    const queue = this.snapshotStateQueues.get(name);
    if (queue && queue.length > 0) return queue.shift()!;
    return current;
  }

  private advanceSandboxState(name: string, current: string): string {
    const queue = this.sandboxStateQueues.get(name);
    if (queue && queue.length > 0) return queue.shift()!;
    return current;
  }

  json<T>(path: string, init: RequestInit = {}, _options: unknown = {}): Promise<T> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.call(method, path, body);

    // Snapshot listing: `GET /snapshots?name=<n>&limit=20&page=1`
    if (method === 'GET' && path.startsWith('/snapshots?')) {
      const name = decodeURIComponent(path.split('name=')[1]?.split('&')[0] ?? '');
      const scripts = this.lookupScripts.get(name);
      if (scripts && scripts.length > 0) {
        const provider = scripts.shift()!;
        return Promise.resolve({ items: provider() } as T);
      }
      const items = [...this.snapshots.values()].filter((s) => s.name === name);
      return Promise.resolve({ items } as T);
    }

    // Snapshot delete by id.
    if (method === 'DELETE' && path.startsWith('/snapshots/')) {
      const id = decodeURIComponent(path.slice('/snapshots/'.length));
      this.snapshots.delete(id);
      return Promise.resolve(null as T);
    }

    // Snapshot create.
    if (method === 'POST' && path === '/snapshots') {
      const record: FakeSnapshot = {
        id: `snap-${body.name}`,
        name: body.name,
        state: this.advanceSnapshotState(body.name, 'building'),
        createdAtCall: this.callCount,
      };
      this.snapshots.set(record.id, record);
      this.lastSnapshotCreate = { method, path, body };
      return Promise.resolve(record as T);
    }

    // Snapshot get by id (also serves the POST /snapshots/:id/detail path).
    if (method === 'GET' && /^\/snapshots\/[^?]+$/.test(path)) {
      const id = decodeURIComponent(path.slice('/snapshots/'.length));
      const record = this.snapshots.get(id);
      if (!record) return Promise.reject(new DaytonaHttpError('fake: snapshot gone', 404));
      record.state = this.advanceSnapshotState(record.name, String(record.state));
      return Promise.resolve(record as T);
    }

    // Sandbox create.
    if (method === 'POST' && (path === '/sandbox' || path.startsWith('/sandbox?'))) {
      const record: FakeSandbox = {
        id: body.name,
        name: body.name,
        state: this.advanceSandboxState(body.name, 'started'),
        toolboxProxyUrl: `https://toolbox.invalid/${body.name}`,
        labels: body.labels,
        createdAtCall: this.callCount,
      };
      this.sandboxes.set(record.id, record);
      this.lastSandboxCreate = { method, path, body };
      return Promise.resolve(record as T);
    }

    // Sandbox get by id or name.
    if (method === 'GET' && /^\/sandbox\/[^/]+$/.test(path)) {
      const key = decodeURIComponent(path.slice('/sandbox/'.length));
      const found =
        this.sandboxes.get(key) ??
        [...this.sandboxes.values()].find((s) => s.id === key || s.name === key);
      if (!found) return Promise.reject(new DaytonaHttpError('fake: sandbox gone', 404));
      found.state = this.advanceSandboxState(found.name, String(found.state));
      return Promise.resolve(found as T);
    }

    // Sandbox delete by id (404-tolerant like the real API).
    if (method === 'DELETE' && /^\/sandbox\/[^/]+$/.test(path)) {
      const key = decodeURIComponent(path.slice('/sandbox/'.length));
      const found = [...this.sandboxes.values()].find((s) => s.id === key || s.name === key);
      if (found) this.sandboxes.delete(found.id);
      return Promise.resolve(null as T);
    }

    // Toolbox command execution.
    if (method === 'POST' && path.endsWith('/process/execute')) {
      const run = this.box.execute(String(body.command));
      return Promise.resolve({ exitCode: run.exitCode, result: run.result } as T);
    }

    // Snapshot capture from a sandbox.
    if (method === 'POST' && path.endsWith('/snapshot')) {
      const record: FakeSnapshot = {
        id: `snap-${body.name}`,
        name: body.name,
        state: this.advanceSnapshotState(body.name, 'building'),
        createdAtCall: this.callCount,
      };
      this.snapshots.set(record.id, record);
      this.lastCapture = { method, path, body };
      return Promise.resolve(record as T);
    }

    return Promise.reject(
      new DaytonaHttpError(`fake Daytona API has no handler for ${method} ${path}`, 500),
    );
  }

  async bytes(): Promise<Uint8Array> {
    throw new Error('fake Daytona API does not serve bytes');
  }

  callsTo(pattern: RegExp): Call[] {
    return this.calls.filter((c) => pattern.test(c.path));
  }

  lastCall(pattern: RegExp): Call | undefined {
    const hits = this.callsTo(pattern);
    return hits[hits.length - 1];
  }
}

const LOCK_HASH = 'b'.repeat(64);
const WARM_SNAPSHOT_NAME = `kortix-ci-daytona-${DAYTONA_CI_SNAPSHOT_VERSION}-${LOCK_HASH.slice(0, 16)}`;
const BASE_SNAPSHOT_NAME = `kortix-ci-daytona-v4-${LOCK_HASH.slice(0, 16)}-base`;
const BUILDER_NAME = `${WARM_SNAPSHOT_NAME}-builder`.slice(0, 64);

function makeInput(over: Partial<DaytonaCiInput> = {}): DaytonaCiInput {
  return {
    apiUrl: 'https://api.daytona.invalid',
    apiKey: 'test-key',
    target: 'us',
    repository: 'kortix-ai/suna',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    runId: 'run-1432',
    runAttempt: '1',
    testArgs: [],
    root: '/tmp/ke2e-daytona-orchestration',
    ...over,
  };
}

function snapRecord(name: string, state: string, over: Partial<DaytonaSnapshot> = {}): FakeSnapshot {
  return { id: `snap-${name}`, name, state, createdAtCall: 0, ...over };
}

function sandboxRecord(
  name: string,
  state: string,
  over: Partial<DaytonaSandbox> = {},
): FakeSandbox {
  return {
    id: name,
    name,
    state,
    toolboxProxyUrl: `https://toolbox.invalid/${name}`,
    labels: {},
    createdAtCall: 0,
    ...over,
  };
}

function foreignBuilder(): FakeSandbox {
  return sandboxRecord(BUILDER_NAME, 'started', {
    labels: { 'kortix-ci': 'true', 'kortix-ci-run-id': 'other-run', 'kortix-ci-run-attempt': '9' },
  });
}

/** The DELETE calls for the warm builder sandbox. */
function builderDeletes(api: FakeDaytona): Call[] {
  return api.calls.filter(
    (c) => c.method === 'DELETE' && c.path === `/sandbox/${encodeURIComponent(BUILDER_NAME)}`,
  );
}

/** Drive a polling promise that sleeps under the fake clock. */
async function runWithClock<T>(promise: Promise<T>, ms: number): Promise<T> {
  const collected: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  const tracked = promise.then(
    (value) => {
      collected.value = value;
      collected.settled = true;
      return value;
    },
    (error: unknown) => {
      collected.error = error;
      collected.settled = true;
      throw error;
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  if (!collected.settled) {
    await vi.advanceTimersByTimeAsync(ms);
  }
  return tracked;
}

describe('Daytona warm-snapshot orchestration (characterization)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // daytona-ci and the shared platinum observer sleep through Bun.sleep when
    // the caller injects none; under vitest's node runtime the global Bun does
    // not exist, so hand it a timer-backed sleep the fake clock can advance.
    vi.stubGlobal('Bun', {
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('waitForSandbox returns a started sandbox without polling', async () => {
    const api = new FakeDaytona();
    const result = await waitForSandbox(api as never, sandboxRecord('sbx-1', 'started'));
    expect(result.id).toBe('sbx-1');
    expect(api.calls).toHaveLength(0);
  });

  test('waitForSandbox throws on each terminal sandbox state with its reason', async () => {
    for (const state of ['error', 'build_failed', 'destroyed', 'archived']) {
      const api = new FakeDaytona();
      await expect(
        waitForSandbox(
          api as never,
          sandboxRecord('sbx-1', state, { errorReason: 'provider said no' }),
        ),
      ).rejects.toThrow(`Daytona sandbox sbx-1 entered state=${state}: provider said no`);
    }
  });

  test('waitForSandbox polls a restoring sandbox to started', async () => {
    const api = new FakeDaytona();
    api.sandboxes.set('sbx-1', sandboxRecord('sbx-1', 'restoring'));
    api.queueSandboxStates('sbx-1', 'started');
    const result = await runWithClock(
      waitForSandbox(api as never, sandboxRecord('sbx-1', 'restoring')),
      15_000,
    );
    expect(result.state).toBe('started');
    expect(api.callsTo(/^\/sandbox\/sbx-1$/)).toHaveLength(1);
  });

  test('waitForSandbox times out with the 15-minute message', async () => {
    const api = new FakeDaytona();
    api.sandboxes.set('sbx-1', sandboxRecord('sbx-1', 'restoring'));
    const expectation = expect(
      runWithClock(waitForSandbox(api as never, sandboxRecord('sbx-1', 'restoring')), 16 * 60_000),
    ).rejects.toThrow('Daytona sandbox sbx-1 did not become started within 900000ms');
    await expectation;
  });

  test('reuses a healthy warm snapshot: no base snapshot and no builder', async () => {
    const api = new FakeDaytona();
    api.snapshots.set(`snap-${WARM_SNAPSHOT_NAME}`, snapRecord(WARM_SNAPSHOT_NAME, 'active'));
    const result = await ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH);
    expect(result.name).toBe(WARM_SNAPSHOT_NAME);
    expect(result.state).toBe('active');
    expect(api.lastSnapshotCreate).toBeUndefined();
    expect(api.lastSandboxCreate).toBeUndefined();
    expect(api.lastCapture).toBeUndefined();
  });

  test('polls a warm snapshot that is still building from the cache-hit path', async () => {
    const api = new FakeDaytona();
    api.snapshots.set(`snap-${WARM_SNAPSHOT_NAME}`, snapRecord(WARM_SNAPSHOT_NAME, 'building'));
    api.queueSnapshotStates(WARM_SNAPSHOT_NAME, 'active');
    const result = await runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000);
    expect(result.state).toBe('active');
  });

  test('throws when a cached building snapshot turns terminal', async () => {
    const api = new FakeDaytona();
    api.snapshots.set(`snap-${WARM_SNAPSHOT_NAME}`, snapRecord(WARM_SNAPSHOT_NAME, 'building'));
    api.queueSnapshotStates(WARM_SNAPSHOT_NAME, 'error');
    const failure = expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000),
    ).rejects.toThrow(
      `Daytona snapshot ${WARM_SNAPSHOT_NAME} entered state=error: `,
    );
    await failure;
  });

  test('times out a cached building snapshot with the 45-minute message', async () => {
    const api = new FakeDaytona();
    api.snapshots.set(`snap-${WARM_SNAPSHOT_NAME}`, snapRecord(WARM_SNAPSHOT_NAME, 'building'));
    await expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 46 * 60_000),
    ).rejects.toThrow(
      `Daytona snapshot ${WARM_SNAPSHOT_NAME} did not become active within 2700000ms`,
    );
  });

  test('deletes a failed warm snapshot, builds the base, then captures through the warm builder', async () => {
    const api = new FakeDaytona();
    api.snapshots.set(
      `snap-${WARM_SNAPSHOT_NAME}`,
      snapRecord(WARM_SNAPSHOT_NAME, 'build_failed', { errorReason: 'boom' }),
    );
    api.box.files.set('/workspace/.kortix-ci-warm-ready', '12\n');
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.queueSnapshotStates(WARM_SNAPSHOT_NAME, 'active');

    const result = await runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 20_000);

    // The failed warm snapshot is deleted first.
    expect(
      api.calls.some(
        (c) => c.method === 'DELETE' && c.path === `/snapshots/snap-${WARM_SNAPSHOT_NAME}`,
      ),
    ).toBe(true);
    // The base snapshot is created with the pinned shape and size.
    expect(api.lastSnapshotCreate?.body).toMatchObject({
      name: BASE_SNAPSHOT_NAME,
      cpu: 6,
      memory: 12,
      disk: 40,
      regionId: 'us',
    });
    expect(String(api.lastSnapshotCreate?.body?.buildInfo?.dockerfileContent)).toContain(
      'kortix-ai/suna',
    );
    // The warm builder is created from the base snapshot with the exact owner labels.
    expect(api.lastSandboxCreate?.body).toMatchObject({
      name: BUILDER_NAME,
      snapshot: BASE_SNAPSHOT_NAME,
      target: 'us',
      public: false,
      autoStopInterval: 15,
      autoArchiveInterval: 1_440,
      autoDeleteInterval: 1_440,
    });
    expect(api.lastSandboxCreate?.body?.labels).toEqual({
      'kortix-ci': 'true',
      'kortix-ci-run-id': 'run-1432',
      'kortix-ci-run-attempt': '1',
      'kortix-ci-repository': 'kortix-ai/suna',
      'kortix-ci-git-sha': 'a'.repeat(40),
    });
    // The warm script is uploaded and launched inside the builder.
    expect(api.box.uploads).toEqual(['/workspace/prepare-daytona-warm.sh']);
    expect(api.box.launches).toHaveLength(1);
    // The warm snapshot is captured from the builder under the canonical name.
    expect(api.lastCapture?.body).toEqual({ name: WARM_SNAPSHOT_NAME });
    // The builder is deleted even on success.
    expect(builderDeletes(api)).toHaveLength(1);
    expect(result.name).toBe(WARM_SNAPSHOT_NAME);
    expect(result.state).toBe('active');
  });

  test('adopts a warm snapshot that appeared while the base snapshot was building', async () => {
    const api = new FakeDaytona();
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    // First warm lookup: a miss. Second (after the base build): the capture exists.
    api.queueLookup(
      WARM_SNAPSHOT_NAME,
      () => [],
      () => [snapRecord(WARM_SNAPSHOT_NAME, 'active')],
    );
    const result = await runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 20_000);
    expect(result.name).toBe(WARM_SNAPSHOT_NAME);
    expect(api.lastSandboxCreate).toBeUndefined();
    expect(api.box.uploads).toHaveLength(0);
  });

  test('waits out a foreign warm builder and adopts the snapshot it captures', async () => {
    const api = new FakeDaytona();
    api.sandboxes.set(BUILDER_NAME, foreignBuilder());
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    // Initial lookup and the post-base re-check miss; the first ownership poll
    // also misses, and the second adopts the foreign capture.
    api.queueLookup(
      WARM_SNAPSHOT_NAME,
      () => [],
      () => [],
      () => [],
      () => [snapRecord(WARM_SNAPSHOT_NAME, 'active')],
    );
    const result = await runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 20_000);
    expect(result.name).toBe(WARM_SNAPSHOT_NAME);
    // The foreign builder was never deleted and no own builder was created.
    expect(builderDeletes(api)).toHaveLength(0);
    expect(api.lastSandboxCreate).toBeUndefined();
    expect(api.box.uploads).toHaveLength(0);
  });

  test('deletes a stopped foreign builder and starts its own', async () => {
    const api = new FakeDaytona();
    api.sandboxes.set(
      BUILDER_NAME,
      sandboxRecord(BUILDER_NAME, 'stopped', {
        labels: { 'kortix-ci': 'true', 'kortix-ci-run-id': 'other-run', 'kortix-ci-run-attempt': '9' },
      }),
    );
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.queueSnapshotStates(WARM_SNAPSHOT_NAME, 'active');
    api.box.files.set('/workspace/.kortix-ci-warm-ready', '7\n');
    const result = await runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 20_000);
    // One delete for the stopped foreign builder, one for the own builder in
    // the finally block.
    expect(builderDeletes(api)).toHaveLength(2);
    expect(api.lastSandboxCreate?.body?.name).toBe(BUILDER_NAME);
    expect(result.name).toBe(WARM_SNAPSHOT_NAME);
  });

  test('throws when the warm script upload fails, and still deletes the builder', async () => {
    const api = new FakeDaytona();
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.box.uploadFails = true;
    await expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000),
    ).rejects.toThrow('Daytona warm script upload failed: toolbox refused');
    expect(builderDeletes(api)).toHaveLength(1);
  });

  test('throws when the warm preparation exits non-zero', async () => {
    const api = new FakeDaytona();
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.box.warmExitCode = '2';
    await expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000),
    ).rejects.toThrow('Daytona warm preparation exited with code 2');
    expect(builderDeletes(api)).toHaveLength(1);
  });

  test('throws when the warm marker is not valid', async () => {
    const api = new FakeDaytona();
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.box.markerValid = false;
    await expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000),
    ).rejects.toThrow('Daytona warm snapshot marker is not valid');
    expect(builderDeletes(api)).toHaveLength(1);
  });

  test('throws when the capture does not produce a snapshot', async () => {
    const api = new FakeDaytona();
    api.queueSnapshotStates(BASE_SNAPSHOT_NAME, 'active');
    api.box.files.set('/workspace/.kortix-ci-warm-ready', '3\n');
    // After the capture POST, the warm name is never findable again.
    api.queueLookup(WARM_SNAPSHOT_NAME, () => [], () => [], () => [], () => [], () => []);
    await expect(
      runWithClock(ensureWarmSnapshot(api as never, makeInput(), LOCK_HASH), 15_000),
    ).rejects.toThrow(`Daytona warm snapshot ${WARM_SNAPSHOT_NAME} was not created`);
    expect(builderDeletes(api)).toHaveLength(1);
  });
});
