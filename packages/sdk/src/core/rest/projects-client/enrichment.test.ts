import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  enrichDomain,
  getEnrichmentJob,
  isEnrichmentJobFinished,
  type EnrichmentJob,
} from './enrichment';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

function job(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    jobId: 'job-1',
    domain: 'example.com',
    status: 'queued',
    errorCode: null,
    result: null,
    createdAt: '2026-07-24T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

test('enrichDomain posts the project and domain', async () => {
  nextResponse = { status: 202, body: job() };

  const result = await enrichDomain({ projectId: 'proj-1', domain: 'example.com' });

  expect(last().method).toBe('POST');
  expect(last().url).toContain('/enrichment/domains');
  expect(last().body).toEqual({ projectId: 'proj-1', domain: 'example.com' });
  expect(result.jobId).toBe('job-1');
});

test('enrichDomain omits force when it is not requested', async () => {
  nextResponse = { status: 202, body: job() };
  await enrichDomain({ projectId: 'proj-1', domain: 'example.com' });
  expect(last().body).not.toHaveProperty('force');
});

test('enrichDomain sends force when re-crawling', async () => {
  nextResponse = { status: 202, body: job() };
  await enrichDomain({ projectId: 'proj-1', domain: 'example.com', force: true });
  expect(last().body).toMatchObject({ force: true });
});

test('enrichDomain forwards an explicit account scope', async () => {
  nextResponse = { status: 202, body: job() };
  await enrichDomain({ projectId: 'proj-1', domain: 'example.com', account_id: 'acc-9' });
  expect(last().body).toMatchObject({ account_id: 'acc-9' });
});

test('enrichDomain returns the attached job when one is already in flight', async () => {
  nextResponse = { status: 200, body: job({ status: 'running' }) };
  const result = await enrichDomain({ projectId: 'proj-1', domain: 'example.com' });
  expect(result.status).toBe('running');
});

test('enrichDomain surfaces a rejected domain', async () => {
  nextResponse = {
    status: 400,
    body: { error: 'invalid_domain', message: 'domain has no public suffix', status: 400 },
  };
  await expect(enrichDomain({ projectId: 'proj-1', domain: 'localhost' })).rejects.toThrow();
});

test('getEnrichmentJob reads one job by id', async () => {
  nextResponse = { status: 200, body: job({ status: 'succeeded' }) };

  const result = await getEnrichmentJob('job-1');

  expect(last().method).toBe('GET');
  expect(last().url).toContain('/enrichment/jobs/job-1');
  expect(result.status).toBe('succeeded');
});

test('getEnrichmentJob returns the memory path of a finished run', async () => {
  nextResponse = {
    status: 200,
    body: job({
      status: 'succeeded',
      result: { memoryPath: '.kortix/memory/enrichment/example.com.md', cacheHit: false },
      finishedAt: '2026-07-24T12:05:00.000Z',
    }),
  };

  const result = await getEnrichmentJob('job-1');
  expect(result.result?.memoryPath).toContain('example.com.md');
});

test('isEnrichmentJobFinished is false while the job can still change', () => {
  expect(isEnrichmentJobFinished(job({ status: 'queued' }))).toBe(false);
  expect(isEnrichmentJobFinished(job({ status: 'running' }))).toBe(false);
});

test('isEnrichmentJobFinished is true for every terminal state', () => {
  expect(isEnrichmentJobFinished(job({ status: 'succeeded' }))).toBe(true);
  expect(isEnrichmentJobFinished(job({ status: 'failed' }))).toBe(true);
  expect(isEnrichmentJobFinished(job({ status: 'dead_lettered' }))).toBe(true);
});
