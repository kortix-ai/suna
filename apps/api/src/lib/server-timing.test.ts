import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { upstreamTiming } from '../middleware/upstream-timing';
import { runWithContext } from './request-context';
import {
  beginStage,
  classifyOutbound,
  formatStageEntries,
  formatStageLogField,
  formatTurnStageEntries,
  installFetchTiming,
  recordTurnStageMarks,
  stageLogFieldForRequest,
  stageSnapshot,
  timeStage,
} from './server-timing';

/**
 * `Server-Timing` stages are how the next latency pass attributes a slow
 * request to auth, GoTrue, IAM, the database, git or an outbound HTTP hop
 * instead of guessing. These pin the accounting (wall time, not a sum), the
 * request isolation, and the header actually shipping.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEntries(value: string | null): Record<string, { dur: number; desc?: string }> {
  const out: Record<string, { dur: number; desc?: string }> = {};
  for (const entry of (value ?? '').split(',')) {
    const match = /^\s*([\w-]+);dur=([\d.]+)(?:;desc="([^"]*)")?\s*$/.exec(entry);
    if (match) out[match[1]!] = { dur: Number(match[2]), desc: match[3] };
  }
  return out;
}

describe('stage accounting', () => {
  test('parallel operations report wall time, and the count of operations', async () => {
    let elapsedMs = 0;
    const snapshot = await runWithContext('GET', '/x', async () => {
      const startedAt = performance.now();
      await Promise.all([1, 2, 3, 4, 5].map(() => timeStage('db', () => sleep(30))));
      elapsedMs = performance.now() - startedAt;
      return stageSnapshot();
    });

    expect(snapshot.db?.count).toBe(5);
    expect(snapshot.db!.wallMs).toBeGreaterThanOrEqual(25);
    // Five overlapping queries report at most the elapsed wall time. A sum of
    // durations would report ~5x it. Compared with the measured elapsed time,
    // not a fixed ceiling, so a loaded runner that delays the timers still
    // passes.
    expect(snapshot.db!.wallMs).toBeLessThanOrEqual(elapsedMs + 1);
  });

  test('sequential operations add up', async () => {
    const snapshot = await runWithContext('GET', '/x', async () => {
      await timeStage('git', () => sleep(20));
      await timeStage('git', () => sleep(20));
      return stageSnapshot();
    });

    expect(snapshot.git?.count).toBe(2);
    expect(snapshot.git!.wallMs).toBeGreaterThanOrEqual(35);
  });

  test('a throwing operation is still closed and still counted', async () => {
    const snapshot = await runWithContext('GET', '/x', async () => {
      await expect(
        timeStage('http', async () => {
          await sleep(15);
          throw new Error('provider down');
        }),
      ).rejects.toThrow('provider down');
      return stageSnapshot();
    });

    expect(snapshot.http?.count).toBe(1);
    expect(snapshot.http!.wallMs).toBeGreaterThanOrEqual(10);
  });

  test('two requests never share stages', async () => {
    await runWithContext('GET', '/a', async () => {
      await timeStage('db', () => sleep(1));
    });
    const second = await runWithContext('GET', '/b', async () => stageSnapshot());

    expect(second).toEqual({});
  });

  test('outside a request every call is a no-op', async () => {
    const end = beginStage('db');
    expect(() => end()).not.toThrow();
    await expect(timeStage('db', async () => 7)).resolves.toBe(7);
    expect(stageSnapshot()).toEqual({});
  });

  test('closing twice does not corrupt the in-flight count', async () => {
    const snapshot = await runWithContext('GET', '/x', async () => {
      const end = beginStage('iam');
      await sleep(10);
      end();
      end();
      await timeStage('iam', () => sleep(10));
      return stageSnapshot();
    });

    expect(snapshot.iam?.count).toBe(2);
    expect(snapshot.iam!.wallMs).toBeGreaterThanOrEqual(15);
  });

  test('entries render in a fixed order with the operation count', () => {
    expect(
      formatStageEntries({ db: { count: 12, wallMs: 30.4 }, auth: { count: 1, wallMs: 4.6 } }),
    ).toEqual(['auth;dur=5;desc="n=1"', 'db;dur=30;desc="n=12"']);
  });
});

describe('slow-request stage log field', () => {
  test('renders fixed order, rounds, and shows the operation count only above one', () => {
    expect(
      formatStageLogField({ db: { count: 12, wallMs: 160.6 }, auth: { count: 1, wallMs: 38.2 } }),
    ).toBe('auth=38,db=161(n=12)');
  });

  test('an empty snapshot renders empty', () => {
    expect(formatStageLogField({})).toBe('');
  });

  test('a fast request carries no field', async () => {
    const field = await runWithContext('GET', '/x', async () => {
      await timeStage('db', () => sleep(1));
      return stageLogFieldForRequest(60);
    });
    expect(field).toBeNull();
  });

  test('a slow request carries the stage breakdown from the live snapshot', async () => {
    const field = await runWithContext('GET', '/x', async () => {
      await timeStage('db', () => sleep(5));
      await timeStage('db', () => sleep(5));
      await timeStage('http', () => sleep(2));
      return stageLogFieldForRequest(1_500);
    });
    expect(field).toMatch(/^db=\d+\(n=2\),http=\d+$/);
  });

  test('a slow request with no recorded stages carries no field', () => {
    expect(stageLogFieldForRequest(5_000)).toBeNull();
  });
});

describe('classifyOutbound', () => {
  test('GoTrue is its own stage; everything else is http', () => {
    const supabase = 'https://project.supabase.co/';
    expect(classifyOutbound('https://project.supabase.co/auth/v1/user', supabase)).toBe('gotrue');
    expect(classifyOutbound('https://project.supabase.co/rest/v1/x', supabase)).toBe('http');
    expect(classifyOutbound('https://api.github.com/repos', supabase)).toBe('http');
    expect(classifyOutbound('https://project.supabase.co/auth/v1/user', undefined)).toBe('http');
  });
});

describe('installFetchTiming', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('attributes an outbound call made inside a request, and is idempotent', async () => {
    globalThis.fetch = (async () => {
      await sleep(20);
      return new Response('ok');
    }) as unknown as typeof fetch;
    installFetchTiming('https://project.supabase.co');
    const wrapped = globalThis.fetch;
    installFetchTiming('https://project.supabase.co');
    expect(globalThis.fetch).toBe(wrapped);

    const snapshot = await runWithContext('GET', '/x', async () => {
      await fetch('https://project.supabase.co/auth/v1/user');
      await fetch('https://sandbox.example.test/health');
      return stageSnapshot();
    });

    expect(snapshot.gotrue?.count).toBe(1);
    expect(snapshot.gotrue!.wallMs).toBeGreaterThanOrEqual(15);
    expect(snapshot.http?.count).toBe(1);
  });

  test('a failing outbound call still rejects for the caller', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    installFetchTiming(undefined);

    const snapshot = await runWithContext('GET', '/x', async () => {
      await expect(fetch('https://down.example.test')).rejects.toThrow('connection refused');
      return stageSnapshot();
    });

    expect(snapshot.http?.count).toBe(1);
  });
});

describe('Server-Timing header', () => {
  test('carries total, every recorded stage, and the existing api split', async () => {
    const app = new Hono();
    app.use('*', (c, next) => runWithContext('GET', c.req.path, () => next()));
    app.use('*', upstreamTiming);
    app.get('/work', async (c) => {
      await timeStage('auth', () => sleep(5));
      await Promise.all([timeStage('db', () => sleep(20)), timeStage('db', () => sleep(20))]);
      return c.json({ ok: true });
    });

    const res = await app.request('/work');
    const entries = parseEntries(res.headers.get('server-timing'));

    expect(entries.total!.dur).toBeGreaterThanOrEqual(20);
    expect(entries.auth!.desc).toBe('n=1');
    expect(entries.db!.desc).toBe('n=2');
    expect(entries.db!.dur).toBeGreaterThanOrEqual(15);
    expect(entries.db!.dur).toBeLessThanOrEqual(entries.total!.dur);
    expect(entries.api).toBeDefined();
    expect(entries.git).toBeUndefined();
  });
});

/**
 * The turn-latency spec (PR #7840) §5: the turn-path's own stage breakdown
 * (`ProvisionTimeline` — `apps/api/src/platform/services/provision-timeline.ts`)
 * rides the SAME `Server-Timing` header as `auth`/`db`/`git`/`http`, not a
 * second header. Each mark is namespaced `turnstage-<label>` so the benchmark
 * can recognize every entry belonging to the turn breakdown WITHOUT hardcoding
 * the current stage names — three concurrent branches are actively adding and
 * renaming `ptl.mark(...)` calls in `sandbox-proxy/routes/preview.ts`, and a
 * namespace prefix is what lets a new stage show up automatically instead of
 * silently being dropped by an allowlist.
 */
describe('turn stage marks (ProvisionTimeline on Server-Timing)', () => {
  test('recorded marks render namespaced, in order', async () => {
    const entries = await runWithContext('POST', '/v1/p/sb-1/8000/session/x/prompt_async', async () => {
      recordTurnStageMarks([
        { label: 'load-sandbox', deltaMs: 4.2 },
        { label: 'ingress', deltaMs: 18 },
      ]);
      return formatTurnStageEntries();
    });
    expect(entries).toEqual(['turnstage-load-sandbox;dur=4', 'turnstage-ingress;dur=18']);
  });

  test('is a no-op outside a request scope, like the other stage recorders', () => {
    expect(() => recordTurnStageMarks([{ label: 'load-sandbox', deltaMs: 1 }])).not.toThrow();
    expect(formatTurnStageEntries()).toEqual([]);
  });

  test('two requests never share turn stage marks', async () => {
    await runWithContext('POST', '/a', async () => {
      recordTurnStageMarks([{ label: 'load-sandbox', deltaMs: 1 }]);
    });
    const entriesB = await runWithContext('POST', '/b', async () => formatTurnStageEntries());
    expect(entriesB).toEqual([]);
  });

  test('appears on the Server-Timing header only for a request that recorded marks', async () => {
    const app = new Hono();
    app.use('*', (c, next) => runWithContext('GET', c.req.path, () => next()));
    app.use('*', upstreamTiming);
    app.get('/turn', (c) => {
      recordTurnStageMarks([
        { label: 'load-sandbox', deltaMs: 4 },
        { label: 'turn-accept', deltaMs: 1 },
      ]);
      return c.json({ ok: true });
    });
    app.get('/plain', (c) => c.json({ ok: true }));

    const turnRes = await app.request('/turn');
    const turnEntries = parseEntries(turnRes.headers.get('server-timing'));
    expect(turnEntries['turnstage-load-sandbox']).toEqual({ dur: 4, desc: undefined });
    expect(turnEntries['turnstage-turn-accept']).toEqual({ dur: 1, desc: undefined });

    const plainRes = await app.request('/plain');
    const plainHeader = plainRes.headers.get('server-timing') ?? '';
    expect(plainHeader).not.toContain('turnstage-');
  });
});
