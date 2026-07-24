import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { createEnrichmentRouter, type EnrichmentRouteDeps } from './enrichment';

const TEST_USER = '00000000-0000-4000-a000-000000000001';
const TEST_ACCOUNT = '00000000-0000-4000-a000-0000000000a1';
const TEST_PROJECT = '00000000-0000-4000-a000-0000000000b1';
const TEST_JOB = '00000000-0000-4000-a000-0000000000c1';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: TEST_JOB,
    accountId: TEST_ACCOUNT,
    projectId: TEST_PROJECT,
    createdBy: TEST_USER,
    domain: 'example.com',
    idempotencyKey: `${TEST_PROJECT}:example.com`,
    status: 'queued',
    errorCode: null,
    lastError: null,
    attempts: 0,
    availableAt: new Date('2026-07-24T12:00:00Z'),
    lockedBy: null,
    lockedUntil: null,
    payload: {},
    result: null,
    createdAt: new Date('2026-07-24T12:00:00Z'),
    updatedAt: new Date('2026-07-24T12:00:00Z'),
    finishedAt: null,
    ...overrides,
  } as never;
}

let enqueued: Array<Record<string, unknown>>;
let attachNext: boolean;
let projectOwned: boolean;
let jobRow: ReturnType<typeof makeJob> | null;

function buildApp() {
  const deps: EnrichmentRouteDeps = {
    resolveAccountId: async () => TEST_ACCOUNT,
    projectBelongsToAccount: async () => projectOwned,
    enqueue: (async (args: Record<string, unknown>) => {
      enqueued.push(args);
      return { job: makeJob({ domain: args.domain }), attached: attachNext };
    }) as never,
    getJob: (async () => jobRow) as never,
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', TEST_USER);
    await next();
  });
  app.route('/v1/enrichment', createEnrichmentRouter(deps));
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: true, message: err.message, status }, status as never);
  });
  return app;
}

function post(body: unknown) {
  return buildApp().request('/v1/enrichment/domains', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getJobRequest(id = TEST_JOB) {
  return buildApp().request(`/v1/enrichment/jobs/${id}`);
}

beforeEach(() => {
  enqueued = [];
  attachNext = false;
  projectOwned = true;
  jobRow = null;
});

describe('POST /v1/enrichment/domains', () => {
  test('queues a job and returns 202', async () => {
    const res = await post({ domain: 'example.com', projectId: TEST_PROJECT });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.jobId).toBe(TEST_JOB);
  });

  test('normalizes the domain before queueing', async () => {
    await post({ domain: 'https://WWW.Example.com/pricing', projectId: TEST_PROJECT });
    expect(enqueued[0].domain).toBe('example.com');
  });

  test('keys the job on project and domain', async () => {
    await post({ domain: 'example.com', projectId: TEST_PROJECT });
    expect(enqueued[0].idempotencyKey).toBe(`${TEST_PROJECT}:example.com`);
  });

  test('returns 200 when attaching to an in-flight job', async () => {
    attachNext = true;
    const res = await post({ domain: 'example.com', projectId: TEST_PROJECT });
    expect(res.status).toBe(200);
  });

  test('rejects an unusable domain with invalid_domain', async () => {
    const res = await post({ domain: 'localhost', projectId: TEST_PROJECT });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_domain');
    expect(enqueued).toHaveLength(0);
  });

  test('rejects an ip literal', async () => {
    const res = await post({ domain: '169.254.169.254', projectId: TEST_PROJECT });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  test('rejects a body missing the project', async () => {
    const res = await post({ domain: 'example.com' });
    expect(res.status).toBe(400);
  });

  test('rejects a non-uuid project id', async () => {
    const res = await post({ domain: 'example.com', projectId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  test('404s a project the account does not own', async () => {
    projectOwned = false;
    const res = await post({ domain: 'example.com', projectId: TEST_PROJECT });

    expect(res.status).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  test('passes the force flag through', async () => {
    await post({ domain: 'example.com', projectId: TEST_PROJECT, force: true });
    expect(enqueued[0].force).toBe(true);
  });

  test('defaults force to false', async () => {
    await post({ domain: 'example.com', projectId: TEST_PROJECT });
    expect(enqueued[0].force).toBe(false);
  });

  test('attributes the job to the calling user and resolved account', async () => {
    await post({ domain: 'example.com', projectId: TEST_PROJECT });
    expect(enqueued[0].createdBy).toBe(TEST_USER);
    expect(enqueued[0].accountId).toBe(TEST_ACCOUNT);
  });
});

describe('GET /v1/enrichment/jobs/:id', () => {
  test('returns the job', async () => {
    jobRow = makeJob({ status: 'succeeded', result: { domain: 'example.com', cacheHit: false } });
    const res = await getJobRequest();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('succeeded');
    expect(body.result.domain).toBe('example.com');
  });

  test('surfaces the typed error code of a failed job', async () => {
    jobRow = makeJob({ status: 'failed', errorCode: 'blocked' });
    expect((await (await getJobRequest()).json()).errorCode).toBe('blocked');
  });

  test('404s an unknown job', async () => {
    jobRow = null;
    expect((await getJobRequest()).status).toBe(404);
  });

  test('rejects a malformed job id', async () => {
    expect((await getJobRequest('not-a-uuid')).status).toBe(400);
  });

  test('serializes timestamps as iso strings', async () => {
    jobRow = makeJob({ finishedAt: new Date('2026-07-24T12:05:00Z') });
    const body = await (await getJobRequest()).json();

    expect(body.createdAt).toBe('2026-07-24T12:00:00.000Z');
    expect(body.finishedAt).toBe('2026-07-24T12:05:00.000Z');
  });

  test('reports a null result for a job that has not finished', async () => {
    jobRow = makeJob({ status: 'running' });
    const body = await (await getJobRequest()).json();

    expect(body.result).toBeNull();
    expect(body.finishedAt).toBeNull();
  });
});
