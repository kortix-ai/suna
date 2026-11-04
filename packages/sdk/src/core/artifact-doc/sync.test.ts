import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import type { ArtifactDocPage, ArtifactDocSeed } from '../rest/projects-client/artifact-doc';
import type { EventStreamTimerHandle, EventStreamTimers } from '../stream/event-stream';
import {
  createArtifactDocSync,
  type ArtifactDocSync,
  type ArtifactDocSyncClient,
  type ArtifactDocSyncOptions,
  type ArtifactDocSyncStatus,
} from './sync';

const PID = 'project-a';
const AID = 'artifact-a';
const HOLDER = 'tab-a';
const EXPIRY = '2026-11-04T00:00:15.000Z';

// ── A manual clock: timers fire only when the test advances time ───────────

async function tick(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createClock() {
  let time = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: EventStreamTimers = {
    now: () => time,
    setTimeout: (fn, ms = 0) => {
      const id = ++seq;
      pending.set(id, { at: time + ms, fn });
      return id as unknown as EventStreamTimerHandle;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) pending.delete(handle as unknown as number);
    },
  };
  async function advance(ms: number): Promise<void> {
    const target = time + ms;
    await tick();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      pending.delete(next[0]);
      time = next[1].at;
      next[1].fn();
      await tick();
    }
    time = target;
  }
  return { timers, advance, now: () => time, timerCount: () => pending.size };
}

// ── A fake doc client: every call stays pending until the test answers it ──

type Method = keyof ArtifactDocSyncClient;
interface Call {
  method: Method;
  args: unknown[];
  settled: boolean;
  ok(value: unknown): Promise<void>;
  fail(error: unknown): Promise<void>;
}

function createFakeClient() {
  const calls: Call[] = [];
  const make = (method: Method) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const call: Call = {
        method,
        args,
        settled: false,
        ok: async (value) => {
          call.settled = true;
          resolve(value);
          await tick();
        },
        fail: async (error) => {
          call.settled = true;
          reject(error);
          await tick();
        },
      };
      calls.push(call);
    });
  const client = {
    get: make('get'),
    seed: make('seed'),
    push: make('push'),
    lease: make('lease'),
    flushed: make('flushed'),
    reset: make('reset'),
  } as unknown as ArtifactDocSyncClient;
  const of = (method: Method) => calls.filter((call) => call.method === method);
  const pending = (method: Method) => of(method).filter((call) => !call.settled);
  const next = (method: Method) => {
    const call = pending(method)[0];
    if (!call) throw new Error(`no pending ${method} call; calls: ${calls.map((c) => c.method).join(', ')}`);
    return call;
  };
  return { client, calls, of, pending, next };
}

// ── Bytes: one update is one byte (its "id"); the fake merge concatenates ──

const u = (...values: number[]) => new Uint8Array(values);
const concat = (parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
const rows = (...pairs: Array<[number, number[]]>) => pairs.map(([seq, values]) => ({ seq, update: u(...values) }));
const EPOCH = 'epoch-1';
const page = (overrides: Partial<ArtifactDocPage> = {}): ArtifactDocPage => ({
  seeded: true,
  epoch: overrides.seeded === false ? null : EPOCH,
  latest_seq: overrides.updates?.at(-1)?.seq ?? 0,
  updates: [],
  has_more: false,
  flushed: null,
  lease: null,
  ...overrides,
});
const network = () => new ApiError('Failed to fetch');
const http = (status: number, code?: string) => new ApiError(`HTTP ${status}`, { status, code: code ?? String(status) });

let open: ArtifactDocSync[] = [];
afterEach(() => {
  for (const sync of open) void sync.close();
  open = [];
});

const SEED: ArtifactDocSeed = { update: u(100, 101), markdown: '# Plan\n', version: 'entry-1' };
/** A stored update whose apply throws in the host: a poisoned row. */
const POISON = 66;

function setup(overrides: Partial<ArtifactDocSyncOptions> = {}) {
  const clock = createClock();
  const fake = createFakeClient();
  const applied: number[][] = [];
  const merges: number[][][] = [];
  const leaders: boolean[] = [];
  const statuses: ArtifactDocSyncStatus[] = [];
  const errors: unknown[] = [];
  const seeds: Array<{ restart: boolean }> = [];
  const resets: unknown[] = [];
  const sync = createArtifactDocSync({
    projectId: PID,
    artifactId: AID,
    holder: HOLDER,
    apply: (update) => {
      if (update[0] === POISON) throw new Error('a crafted update');
      applied.push([...update]);
    },
    onReset: (event) => resets.push(event),
    merge: (parts) => {
      merges.push(parts.map((part) => [...part]));
      return concat(parts);
    },
    onLeader: (leader) => leaders.push(leader),
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    timers: clock.timers,
    client: fake.client,
    ...overrides,
  });
  open.push(sync);
  const buildSeed = (context: { restart: boolean }) => {
    seeds.push(context);
    return SEED;
  };

  /** Start on a seeded doc holding `stored`, and answer the first lease. */
  async function started(stored = rows([1, [1]], [2, [2]]), leader = false) {
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ updates: stored, flushed: { seq: 0, version: 'entry-1', markdown: '# Plan\n' } }));
    await fake.next('lease').ok({ leader, holder: leader ? HOLDER : 'tab-b', expires_at: EXPIRY });
    return starting;
  }
  /** Push one update and let its 50 ms batch window close. */
  async function pushNow(update: Uint8Array) {
    sync.push(update);
    await clock.advance(50);
  }
  return { clock, fake, sync, applied, merges, leaders, statuses, errors, seeds, resets, buildSeed, started, pushNow };
}

describe('createArtifactDocSync: start', () => {
  test('a seeded doc: the stored updates are applied in order, the lease is taken, and start resolves with the flushed base', async () => {
    const { fake, sync, applied, leaders, statuses, started } = setup();
    expect(sync.status).toBe('connecting');
    const result = await started(rows([1, [1]], [2, [2]]), true);
    expect(fake.of('get')[0]!.args).toEqual([PID, AID, { after: 0, base: true }]);
    expect(fake.of('lease')[0]!.args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH }]);
    expect(applied).toEqual([[1], [2]]);
    expect(sync.covered).toBe(2);
    expect(result).toEqual({ created: false, base: { markdown: '# Plan\n', version: 'entry-1', seq: 0 } });
    expect(sync.leader).toBe(true);
    expect(leaders).toEqual([true]);
    expect(statuses).toEqual(['synced']);
    expect(fake.of('seed')).toEqual([]);
  });

  test('stored updates over several pages are all applied before start resolves', async () => {
    const { fake, sync, applied, buildSeed } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ updates: rows([1, [1]], [2, [2]]), has_more: true, flushed: { seq: 0, version: 'entry-1', markdown: '' } }));
    expect(fake.next('get').args).toEqual([PID, AID, { after: 2, base: false }]);
    await fake.next('get').ok(page({ updates: rows([3, [3]]) }));
    await fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    expect((await starting).created).toBe(false);
    expect(applied).toEqual([[1], [2], [3]]);
    expect(sync.covered).toBe(3);
  });

  test('an unseeded doc: buildSeed runs, and the seed is applied only once the server accepted it', async () => {
    const { fake, sync, applied, seeds, buildSeed } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ seeded: false }));
    expect(seeds).toEqual([{ restart: false }]);
    expect(fake.next('seed').args).toEqual([PID, AID, SEED]);
    expect(applied).toEqual([]);
    await fake.next('seed').ok({ seq: 1, epoch: EPOCH });
    expect(applied).toEqual([[100, 101]]);
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    expect(await starting).toEqual({ created: true, base: { markdown: '# Plan\n', version: 'entry-1', seq: 1 } });
    expect(sync.covered).toBe(1);
  });

  test('the seed race: a 409 doc_seeded drops this seed, and the doc another tab seeded is pulled and applied', async () => {
    const { fake, sync, applied, buildSeed, errors } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ seeded: false }));
    await fake.next('seed').fail(http(409, 'doc_seeded'));
    expect(fake.next('get').args).toEqual([PID, AID, { after: 0, base: true }]);
    await fake.next('get').ok(page({ updates: rows([1, [50, 51]]), flushed: { seq: 1, version: 'entry-1', markdown: '# Theirs\n' } }));
    await fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    expect(await starting).toEqual({ created: false, base: { markdown: '# Theirs\n', version: 'entry-1', seq: 1 } });
    // The local seed never reaches the doc: two histories of one text would duplicate it.
    expect(applied).toEqual([[50, 51]]);
    expect(sync.covered).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a transient failure while loading retries with backoff; a refusal rejects start and fails', async () => {
    const { clock, fake, sync, buildSeed, statuses } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').fail(network());
    expect(sync.status).toBe('retrying');
    await clock.advance(999);
    expect(fake.pending('get')).toHaveLength(0);
    await clock.advance(1);
    await fake.next('get').fail(http(404, 'not_found'));
    await expect(starting).rejects.toMatchObject({ status: 404 });
    expect(statuses).toEqual(['retrying', 'failed']);
  });
});

describe('createArtifactDocSync: covered', () => {
  test('pulled 1, 2 and 4 while this tab\'s own 3 is in flight: covered stays 2 until 3 is acked', async () => {
    const { fake, sync, applied, started, pushNow } = setup();
    await started(rows([1, [1]], [2, [2]]));
    await pushNow(u(30));
    expect(fake.next('push').args).toEqual([PID, AID, u(30), { epoch: EPOCH }]);
    sync.notify(4);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 2, base: false }]);
    await fake.next('get').ok(page({ updates: rows([4, [4]]) }));
    expect(applied).toEqual([[1], [2], [4]]);
    expect(sync.covered).toBe(2);
    await fake.next('push').ok({ seq: 3 });
    expect(sync.covered).toBe(4);
  });

  test('a pull during a push covers only its rows; the ack pulls again, and that pull covers the gap', async () => {
    const { fake, sync, started, pushNow } = setup();
    await started(rows([1, [1]], [2, [2]]));
    await pushNow(u(30));
    sync.notify(5);
    await fake.next('get').ok(page({ updates: rows([5, [5]]) }));
    expect(sync.covered).toBe(2);
    await fake.next('push').ok({ seq: 3 });
    expect(sync.covered).toBe(3);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 3, base: false }]);
    // Seq 4 was compacted into 5.
    await fake.next('get').ok(page({ updates: rows([5, [5]]) }));
    expect(sync.covered).toBe(5);
  });

  test('gaps between the rows of a page are compacted ranges: a merged row holds every seq since the row before it', async () => {
    const { sync, applied, started } = setup();
    await started(rows([1, [1]], [40, [4]], [41, [5]], [90, [9]]));
    expect(applied).toEqual([[1], [4], [5], [9]]);
    expect(sync.covered).toBe(90);
  });

  test('a compacted range before the first row is covered: the merged row holds every seq below it', async () => {
    const { sync, applied, started } = setup();
    await started(rows([500, [5]], [501, [6]]));
    expect(applied).toEqual([[5], [6]]);
    expect(sync.covered).toBe(501);
  });
});

describe('createArtifactDocSync: pulls', () => {
  test('notify pulls an unseen seq only; pulls are serial, and notifies during a pull add exactly one more pull', async () => {
    const { fake, sync, applied, started, pushNow } = setup();
    await started();
    // Seq 2 is here and is the highest: nothing to pull. (A seq below the highest pulls: see the reset tests.)
    sync.notify(2);
    expect(fake.pending('get')).toHaveLength(0);
    sync.notify(3);
    sync.notify(4);
    sync.notify(5);
    expect(fake.pending('get')).toHaveLength(1);
    await fake.next('get').ok(page({ updates: rows([3, [3]]) }));
    expect(fake.next('get').args).toEqual([PID, AID, { after: 3, base: false }]);
    await fake.next('get').ok(page({ updates: rows([4, [4]], [5, [5]]) }));
    expect(fake.pending('get')).toHaveLength(0);
    expect(applied).toEqual([[1], [2], [3], [4], [5]]);
    // The ping for this tab's own update does not pull it back.
    await pushNow(u(60));
    await fake.next('push').ok({ seq: 6 });
    sync.notify(6);
    expect(fake.pending('get')).toHaveLength(0);
    expect(sync.covered).toBe(6);
  });

  test('without a notify for 3 s it polls every 3 s; a notify moves the next poll 3 s out', async () => {
    const { clock, fake, sync, started } = setup();
    await started();
    await clock.advance(2_999);
    expect(fake.pending('get')).toHaveLength(0);
    await clock.advance(1);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 2, base: false }]);
    await fake.next('get').ok(page());
    await clock.advance(3_000);
    await fake.next('get').ok(page());
    await clock.advance(2_000);
    sync.notify(2);
    await clock.advance(2_999);
    expect(fake.pending('get')).toHaveLength(0);
    await clock.advance(1);
    expect(fake.pending('get')).toHaveLength(1);
  });

  test('base() pulls with base=true and returns the flushed markdown', async () => {
    const { fake, sync, applied, started } = setup();
    await started();
    const base = sync.base();
    await tick();
    expect(fake.next('get').args).toEqual([PID, AID, { after: 2, base: true }]);
    await fake.next('get').ok(page({ updates: rows([3, [3]]), flushed: { seq: 3, version: 'entry-4', markdown: '# Plan v4\n' } }));
    expect(await base).toEqual({ markdown: '# Plan v4\n', version: 'entry-4', seq: 3 });
    expect(applied).toEqual([[1], [2], [3]]);
  });

  test('a refused pull (404) reports onError and fails', async () => {
    const { fake, sync, errors, started } = setup();
    await started();
    sync.notify(3);
    const refusal = http(404, 'not_found');
    await fake.next('get').fail(refusal);
    expect(errors).toEqual([refusal]);
    expect(sync.status).toBe('failed');
  });
});

describe('createArtifactDocSync: pushes', () => {
  test('updates within 50 ms go out as one merged push, in order, and one push is in flight at a time', async () => {
    const { clock, fake, sync, merges, statuses, started } = setup();
    await started();
    sync.push(u(10));
    expect(sync.status).toBe('syncing');
    await clock.advance(20);
    sync.push(u(11));
    await clock.advance(20);
    sync.push(u(12));
    expect(fake.pending('push')).toHaveLength(0);
    await clock.advance(10);
    expect(fake.next('push').args).toEqual([PID, AID, u(10, 11, 12), { epoch: EPOCH }]);
    expect(merges).toEqual([[[10], [11], [12]]]);
    sync.push(u(13));
    await clock.advance(10);
    sync.push(u(14));
    await clock.advance(100);
    expect(fake.pending('push')).toHaveLength(1);
    await fake.next('push').ok({ seq: 3 });
    expect(fake.next('push').args).toEqual([PID, AID, u(13, 14), { epoch: EPOCH }]);
    await fake.next('push').ok({ seq: 4 });
    // A single update is sent as it is: no merge.
    sync.push(u(15));
    await clock.advance(50);
    expect(fake.next('push').args).toEqual([PID, AID, u(15), { epoch: EPOCH }]);
    await fake.next('push').ok({ seq: 5 });
    expect(merges).toHaveLength(2);
    expect(sync.covered).toBe(5);
    expect(statuses).toEqual(['synced', 'syncing', 'synced', 'syncing', 'synced']);
  });

  test('a failed push is retried after 1, 2, 4, 8, 16, 30, 30 s, ahead of later updates, and no update is dropped', async () => {
    const { clock, fake, sync, errors, started, pushNow } = setup();
    await started();
    await pushNow(u(10));
    await fake.next('push').fail(network());
    expect(sync.status).toBe('retrying');
    sync.push(u(11));
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      await clock.advance(delay - 1);
      expect(fake.pending('push')).toHaveLength(0);
      await clock.advance(1);
      expect(fake.next('push').args).toEqual([PID, AID, index < 2 ? u(10, 11) : u(10, 11, 12), { epoch: EPOCH }]);
      if (index === 1) sync.push(u(12));
      if (index < delays.length - 1) await fake.next('push').fail(index % 2 ? network() : http(503));
    }
    await fake.next('push').ok({ seq: 3 });
    expect(sync.status).toBe('synced');
    expect(fake.of('push').every((call) => (call.args[2] as Uint8Array)[0] === 10)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a 429 is retried like a network failure, and the backoff resets after a success', async () => {
    const { clock, fake, sync, started, pushNow } = setup();
    await started();
    await pushNow(u(10));
    await fake.next('push').fail(http(429, 'rate_limited'));
    await clock.advance(1_000);
    await fake.next('push').fail(http(429, 'rate_limited'));
    await clock.advance(2_000);
    await fake.next('push').ok({ seq: 3 });
    await pushNow(u(11));
    await fake.next('push').fail(network());
    await clock.advance(1_000);
    expect(fake.pending('push')).toHaveLength(1);
    expect(sync.status).toBe('retrying');
  });

  test('413 on a merged batch splits it; 413 on one update reports onError and fails', async () => {
    const { clock, fake, sync, errors, started } = setup();
    await started([], true);
    sync.push(u(10));
    sync.push(u(11));
    await clock.advance(50);
    expect(fake.next('push').args).toEqual([PID, AID, u(10, 11), { epoch: EPOCH }]);
    await fake.next('push').fail(http(413, 'update_too_large'));
    expect(fake.next('push').args).toEqual([PID, AID, u(10), { epoch: EPOCH }]);
    await fake.next('push').ok({ seq: 1 });
    expect(fake.next('push').args).toEqual([PID, AID, u(11), { epoch: EPOCH }]);
    const tooLarge = http(413, 'update_too_large');
    await fake.next('push').fail(tooLarge);
    expect(errors).toEqual([tooLarge]);
    expect(sync.status).toBe('failed');
    expect(sync.leader).toBe(false);
    expect(fake.next('lease').args).toEqual([PID, AID, { holder: HOLDER, release: true, epoch: EPOCH }, { keepalive: true }]);
    sync.push(u(12));
    await clock.advance(60_000);
    expect(fake.pending('push')).toHaveLength(0);
  });

  test('413 doc_too_large is fatal at once: onError and failed, and the batch is not split', async () => {
    const { clock, fake, sync, errors, started } = setup();
    await started();
    sync.push(u(10));
    sync.push(u(11));
    await clock.advance(50);
    const tooLarge = http(413, 'doc_too_large');
    await fake.next('push').fail(tooLarge);
    expect(errors).toEqual([tooLarge]);
    expect(sync.status).toBe('failed');
    await clock.advance(60_000);
    expect(fake.of('push')).toHaveLength(1);
  });

  test('an update over 512 KiB is never sent: onError and failed', async () => {
    const { clock, fake, sync, errors, started } = setup();
    await started();
    sync.push(new Uint8Array(512 * 1024 + 1));
    await clock.advance(50);
    expect(fake.of('push')).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(sync.status).toBe('failed');
  });

  test('updates pushed before start completes are sent once the doc is loaded', async () => {
    const { fake, sync, buildSeed, clock } = setup();
    const starting = sync.start(buildSeed);
    sync.push(u(10));
    await clock.advance(100);
    expect(fake.of('push')).toEqual([]);
    await fake.next('get').ok(page({ updates: rows([1, [1]]) }));
    await fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    await starting;
    await clock.advance(50);
    expect(fake.next('push').args).toEqual([PID, AID, u(10), { epoch: EPOCH }]);
  });
});

describe('createArtifactDocSync: lease', () => {
  test('the lease is renewed every 5 s, and onLeader reports each gain and loss', async () => {
    const { clock, fake, sync, leaders, started } = setup();
    await started(undefined, false);
    expect(sync.leader).toBe(false);
    expect(leaders).toEqual([]);
    await clock.advance(5_000);
    expect(fake.next('lease').args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH }]);
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    expect(leaders).toEqual([true]);
    await clock.advance(5_000);
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    expect(leaders).toEqual([true]);
    await clock.advance(5_000);
    await fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    expect(leaders).toEqual([true, false]);
    expect(sync.leader).toBe(false);
  });

  test('a leader whose renewals fail steps down 13 s after its last renewal was sent, and leads again on the next success', async () => {
    const { clock, fake, sync, leaders, started } = setup();
    await started(undefined, true);
    await clock.advance(5_000);
    await fake.next('lease').fail(network());
    await clock.advance(5_000);
    await fake.next('lease').fail(http(503));
    await clock.advance(2_999);
    expect(sync.leader).toBe(true);
    await clock.advance(1);
    expect(sync.leader).toBe(false);
    expect(leaders).toEqual([true, false]);
    await clock.advance(2_000);
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    expect(leaders).toEqual([true, false, true]);
  });

  test('a viewer without write access: a 403 lease stops leasing, reports nothing, and the doc keeps pulling', async () => {
    const { clock, fake, sync, errors, buildSeed } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ updates: rows([1, [1]]) }));
    await fake.next('lease').fail(http(403, 'forbidden'));
    await starting;
    await clock.advance(5_000);
    expect(fake.of('lease')).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(sync.status).toBe('synced');
    sync.notify(2);
    expect(fake.pending('get')).toHaveLength(1);
  });
});

describe('createArtifactDocSync: flushed', () => {
  test('flushed waits for the updates pushed before it, then posts covered', async () => {
    const { clock, fake, sync, started } = setup();
    await started(undefined, true);
    sync.push(u(30));
    const flushed = sync.flushed({ version: 'entry-2', markdown: '# Plan\n\nMore.\n' });
    await clock.advance(50);
    expect(fake.pending('flushed')).toHaveLength(0);
    await fake.next('push').ok({ seq: 3 });
    expect(fake.next('flushed').args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH, seq: 3, version: 'entry-2', markdown: '# Plan\n\nMore.\n' }]);
    await fake.next('flushed').ok({ flushed_seq: 3 });
    expect(await flushed).toEqual({ seq: 3, flushed_seq: 3 });
  });

  test('flushed records the seq the host captured when it serialized the Markdown, not covered now', async () => {
    const { fake, sync, started } = setup();
    await started(rows([1, [1]], [2, [2]], [3, [3]]), true);
    const flushed = sync.flushed({ version: 'entry-2', markdown: '# Plan\n', seq: 2 });
    await tick();
    expect(fake.next('flushed').args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH, seq: 2, version: 'entry-2', markdown: '# Plan\n' }]);
    await fake.next('flushed').ok({ flushed_seq: 2 });
    expect(await flushed).toEqual({ seq: 2, flushed_seq: 2 });
    await expect(sync.flushed({ version: 'entry-2', markdown: '', seq: -1 })).rejects.toThrow(RangeError);
  });

  test('a transient failure retries the newest flush; 409 not_leader rejects and reports the lost lease', async () => {
    const { clock, fake, sync, leaders, started } = setup();
    await started(undefined, true);
    const first = sync.flushed({ version: 'entry-2', markdown: 'a' });
    await tick();
    await fake.next('flushed').fail(network());
    const second = sync.flushed({ version: 'entry-3', markdown: 'ab' });
    await clock.advance(1_000);
    expect(fake.next('flushed').args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH, seq: 2, version: 'entry-3', markdown: 'ab' }]);
    await fake.next('flushed').ok({ flushed_seq: 2 });
    expect(await first).toEqual({ seq: 2, flushed_seq: 2 });
    expect(await second).toEqual({ seq: 2, flushed_seq: 2 });

    const third = sync.flushed({ version: 'entry-4', markdown: 'abc' });
    await tick();
    const notLeader = http(409, 'not_leader');
    await fake.next('flushed').fail(notLeader);
    await expect(third).rejects.toBe(notLeader);
    expect(leaders).toEqual([true, false]);
  });
});

describe('createArtifactDocSync: reset (contract v2)', () => {
  test('a pull that finds the doc unseeded stops everything, drops unacked pushes, and reports onReset once', async () => {
    const { clock, fake, sync, statuses, resets, leaders, errors, started, pushNow } = setup();
    await started(undefined, true);
    await pushNow(u(10));
    sync.push(u(11));
    const flushed = sync.flushed({ version: 'entry-2', markdown: 'x' });
    // The reset ping: the server publishes `changed doc` with version '0'.
    sync.notify(0);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 2, base: false }]);
    await fake.next('get').ok(page({ seeded: false }));
    expect(sync.status).toBe('reset');
    expect(statuses.at(-1)).toBe('reset');
    expect(resets).toEqual([{ reason: 'not_seeded' }]);
    expect(leaders).toEqual([true, false]);
    expect(sync.covered).toBe(0);
    await expect(flushed).rejects.toMatchObject({ code: 'doc_reset' });
    // The push in flight answers late; nothing more is sent, polled or leased.
    await fake.next('push').ok({ seq: 3 });
    sync.push(u(12));
    sync.notify(9);
    await clock.advance(60_000);
    expect(fake.calls.filter((call) => !call.settled)).toEqual([]);
    expect(resets).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('after onReset the host calls start again: it seeds from the file on an empty doc and syncs as new, without one old update', async () => {
    const { fake, sync, seeds, applied, buildSeed, started, pushNow } = setup();
    await started();
    await pushNow(u(10));
    sync.push(u(11));
    sync.notify(0);
    await fake.next('get').ok(page({ seeded: false }));
    await fake.next('push').ok({ seq: 3 });
    // An update of the old doc, pushed after the reset, is dropped too.
    sync.push(u(12));
    const again = sync.start(buildSeed);
    expect(sync.status).toBe('connecting');
    await tick();
    expect(fake.next('get').args).toEqual([PID, AID, { after: 0, base: true }]);
    await fake.next('get').ok(page({ seeded: false }));
    expect(seeds).toEqual([{ restart: true }]);
    await fake.next('seed').ok({ seq: 1, epoch: 'epoch-2' });
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    expect(await again).toEqual({ created: true, base: { markdown: '# Plan\n', version: 'entry-1', seq: 1 } });
    expect(applied.at(-1)).toEqual([100, 101]);
    expect(sync.covered).toBe(1);
    await pushNow(u(20));
    expect(fake.next('push').args).toEqual([PID, AID, u(20), { epoch: 'epoch-2' }]);
    await fake.next('push').ok({ seq: 2 });
    expect(sync.status).toBe('synced');
  });

  test('start runs again only after a reset', async () => {
    const { sync, buildSeed, started } = setup();
    await started();
    await expect(sync.start(buildSeed)).rejects.toThrow('runs once');
  });

  test('a push answered 409 doc_not_seeded resets: the doc state was deleted (a reset or the idle GC)', async () => {
    const { fake, sync, resets, started, pushNow } = setup();
    await started();
    await pushNow(u(10));
    await fake.next('push').fail(http(409, 'doc_not_seeded'));
    expect(resets).toEqual([{ reason: 'not_seeded' }]);
    expect(sync.status).toBe('reset');
    expect(fake.calls.filter((call) => !call.settled)).toEqual([]);
  });

  test('a pull with another epoch resets before it applies a row of the new doc', async () => {
    const { fake, sync, applied, resets, started } = setup();
    await started();
    sync.notify(3);
    await fake.next('get').ok(page({ epoch: 'epoch-2', updates: rows([1, [50]], [2, [51]]) }));
    expect(applied).toEqual([[1], [2]]);
    expect(resets).toEqual([{ reason: 'epoch' }]);
  });

  test('a seed answered without an epoch adopts the first epoch a pull reports, and a later change resets', async () => {
    const { fake, sync, resets, buildSeed } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ seeded: false }));
    await fake.next('seed').ok({ seq: 1, epoch: null });
    expect(fake.next('lease').args).toEqual([PID, AID, { holder: HOLDER }]);
    await fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    await starting;
    sync.notify(2);
    await fake.next('get').ok(page({ epoch: 'epoch-7', updates: rows([2, [2]]) }));
    expect(resets).toEqual([]);
    expect(sync.covered).toBe(2);
    sync.notify(3);
    await fake.next('get').ok(page({ epoch: 'epoch-8', updates: rows([1, [9]]) }));
    expect(resets).toEqual([{ reason: 'epoch' }]);
  });

  test('a push, lease renewal or flush answered 409 epoch_mismatch resets with reason epoch', async () => {
    for (const via of ['push', 'lease', 'flushed'] as const) {
      const { clock, fake, sync, resets, errors, started, pushNow } = setup();
      await started(undefined, true);
      let flushed: Promise<unknown> | null = null;
      if (via === 'push') await pushNow(u(10));
      if (via === 'lease') await clock.advance(5_000);
      if (via === 'flushed') {
        flushed = sync.flushed({ version: 'entry-2', markdown: 'x' }).catch((error: unknown) => error);
        await tick();
      }
      await fake.next(via).fail(http(409, 'epoch_mismatch'));
      expect({ via, resets, status: sync.status, errors }).toEqual({ via, resets: [{ reason: 'epoch' }], status: 'reset', errors: [] });
      if (flushed) expect(await flushed).toMatchObject({ code: 'doc_reset' });
    }
  });

  test('a lease renewal answered 409 doc_not_seeded resets instead of giving up the lease', async () => {
    const { clock, fake, sync, resets, errors, buildSeed, started } = setup();
    await started(undefined, true);
    await clock.advance(3_000);
    await fake.next('get').ok(page());
    await clock.advance(2_000);
    await fake.next('lease').fail(http(409, 'doc_not_seeded'));
    expect(resets).toEqual([{ reason: 'not_seeded' }]);
    expect(errors).toEqual([]);
    // Leasing resumes on the next start.
    const again = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ updates: rows([1, [1]]) }));
    expect(fake.next('lease').args).toEqual([PID, AID, { holder: HOLDER, epoch: EPOCH }]);
    await fake.next('lease').ok({ leader: true, holder: HOLDER, expires_at: EXPIRY });
    await again;
    expect(sync.leader).toBe(true);
  });

  test('a ping below the highest seq here pulls at once: after a re-seed seqs restart at 1, under another epoch', async () => {
    const { fake, sync, resets, started, pushNow } = setup();
    await started(rows([1, [1]], [2, [2]]));
    await pushNow(u(10));
    await fake.next('push').ok({ seq: 3 });
    await pushNow(u(11));
    await fake.next('push').ok({ seq: 4 });
    // The echo of this tab's own update pulls nothing.
    sync.notify(3);
    expect(fake.pending('get')).toHaveLength(0);
    // Another tab re-seeded: its first ping is seq 1. No clock advance: no poll is needed.
    sync.notify(1);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 4, base: false }]);
    await fake.next('get').ok(page({ epoch: 'epoch-2', updates: [] }));
    expect(resets).toEqual([{ reason: 'epoch' }]);
  });

  test('a tab that never pushes (a viewer) also pulls at once on a ping below the highest seq it pulled', async () => {
    const { fake, sync, resets, started } = setup();
    await started(rows([1, [1]], [2, [2]], [3, [3]]));
    sync.notify(1);
    expect(fake.next('get').args).toEqual([PID, AID, { after: 3, base: false }]);
    await fake.next('get').ok(page({ seeded: false }));
    expect(resets).toEqual([{ reason: 'not_seeded' }]);
  });

  test('an epoch is adopted only when start saw none; a doc loaded with an epoch resets when a pull reports none', async () => {
    const legacy = setup();
    const starting = legacy.sync.start(legacy.buildSeed);
    await tick();
    // A doc seeded before epochs: the server reports none at start, then its backfill.
    await legacy.fake.next('get').ok(page({ epoch: null, updates: rows([1, [1]]) }));
    await legacy.fake.next('lease').ok({ leader: false, holder: 'tab-b', expires_at: EXPIRY });
    await starting;
    legacy.sync.notify(2);
    await legacy.fake.next('get').ok(page({ epoch: 'epoch-5', updates: rows([2, [2]]) }));
    expect(legacy.resets).toEqual([]);
    legacy.sync.notify(3);
    await legacy.fake.next('get').ok(page({ epoch: 'epoch-6', updates: rows([3, [3]]) }));
    expect(legacy.resets).toEqual([{ reason: 'epoch' }]);

    const { fake, sync, resets, started } = setup();
    await started();
    sync.notify(3);
    await fake.next('get').ok(page({ epoch: null, updates: rows([3, [3]]) }));
    expect(resets).toEqual([{ reason: 'epoch' }]);
  });

  test('a pulled row that makes apply throw: the engine resets the doc on the server, then reports onReset poisoned', async () => {
    const { fake, sync, applied, resets, errors, statuses, started } = setup();
    await started(undefined, true);
    sync.notify(4);
    await fake.next('get').ok(page({ updates: rows([3, [3]], [4, [POISON]], [5, [5]]) }));
    expect(applied).toEqual([[1], [2], [3]]);
    expect(sync.status).toBe('retrying');
    expect(resets).toEqual([]);
    expect(fake.next('reset').args).toEqual([PID, AID, { holder: HOLDER }]);
    await fake.next('reset').ok(undefined);
    expect(resets).toEqual([{ reason: 'poisoned' }]);
    expect(statuses.slice(-2)).toEqual(['retrying', 'reset']);
    expect(errors).toEqual([]);
  });

  test('a poisoned doc led by another tab waits, polling every 3 s, until that tab resets it', async () => {
    const { clock, fake, sync, resets, started } = setup();
    await started(undefined, false);
    sync.notify(3);
    await fake.next('get').ok(page({ updates: rows([3, [POISON]]) }));
    await fake.next('reset').fail(http(409, 'not_leader'));
    expect(fake.next('get').args).toEqual([PID, AID, { after: Number.MAX_SAFE_INTEGER, base: false }]);
    await fake.next('get').ok(page());
    await clock.advance(2_999);
    expect(fake.pending('reset')).toHaveLength(0);
    await clock.advance(1);
    await fake.next('reset').fail(http(409, 'not_leader'));
    await fake.next('get').ok(page({ seeded: false }));
    expect(resets).toEqual([{ reason: 'poisoned' }]);
    expect(sync.status).toBe('reset');
  });

  test('a poisoned stored row rejects start with code doc_reset, resets the doc, and reports onReset', async () => {
    const { fake, sync, resets, buildSeed } = setup();
    const starting = sync.start(buildSeed);
    await tick();
    await fake.next('get').ok(page({ updates: rows([1, [1]], [2, [POISON]]) }));
    await expect(starting).rejects.toMatchObject({ code: 'doc_reset' });
    await fake.next('reset').ok(undefined);
    expect(resets).toEqual([{ reason: 'poisoned' }]);
  });
});

describe('createArtifactDocSync: close', () => {
  test('close sends the pending updates and releases the lease with keepalive, then stops every timer', async () => {
    const { clock, fake, sync, statuses, started, pushNow } = setup();
    await started(undefined, true);
    await pushNow(u(10));
    sync.push(u(11));
    sync.push(u(12));
    const closing = sync.close();
    expect(sync.status).toBe('closed');
    expect(statuses.at(-1)).toBe('closed');
    const finals = fake.pending('push');
    expect(finals.map((call) => call.args)).toEqual([
      [PID, AID, u(10), { epoch: EPOCH }],
      [PID, AID, u(10, 11, 12), { keepalive: true, epoch: EPOCH }],
    ]);
    expect(fake.next('lease').args).toEqual([PID, AID, { holder: HOLDER, release: true, epoch: EPOCH }, { keepalive: true }]);
    for (const call of [...finals, fake.next('lease')]) await call.ok({ seq: 4, leader: false, holder: null, expires_at: null });
    await closing;
    const count = fake.calls.length;
    sync.push(u(13));
    sync.notify(9);
    await clock.advance(60_000);
    expect(fake.calls).toHaveLength(count);
    expect(clock.timerCount()).toBe(0);
    await expect(sync.flushed({ version: 'entry-2', markdown: '' })).rejects.toThrow();
  });

  test('close of a non-leader with nothing pending sends no push', async () => {
    const { fake, sync, started } = setup();
    await started(undefined, false);
    void sync.close();
    expect(fake.pending('push')).toHaveLength(0);
  });
});
