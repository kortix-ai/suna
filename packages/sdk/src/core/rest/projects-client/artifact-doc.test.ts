import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import { ApiError } from '../../http/api-client';
import * as root from '../../../index';
import {
  getArtifactDoc,
  leaseArtifactDoc,
  markArtifactDocFlushed,
  pushArtifactDocUpdate,
  resetArtifactDoc,
  seedArtifactDoc,
} from './artifact-doc';

const originalFetch = globalThis.fetch;
const backendUrl = 'https://artifact-doc.example/v1';
const doc = `${backendUrl}/workspaces/project-a/artifacts/artifact-a/doc`;
const LEASE_EXPIRY = '2026-11-04T00:00:15.000Z';
let calls: { url: string; method: string; body: unknown; authorization: string | null; keepalive: boolean }[] = [];
let reply: () => Response;
let errors: unknown[] = [];

beforeEach(() => {
  calls = [];
  errors = [];
  reply = () => Response.json({ seq: 7 });
  configureKortix({ backendUrl, getToken: async () => 'person-token', onError: (error) => errors.push(error) });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
      keepalive: init?.keepalive === true,
    });
    return reply();
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const bytes = (...values: number[]) => new Uint8Array(values);

test('getArtifactDoc reads the updates after a seq, decodes them to bytes and reads seq columns sent as strings', async () => {
  reply = () => Response.json({
    seeded: true,
    epoch: 'epoch-1',
    latest_seq: '12',
    updates: [{ seq: '11', update: 'AQID' }, { seq: 12, update: '/w==' }],
    has_more: false,
    flushed: { seq: 10, version: 'entry-3', markdown: '# Plan\n' },
    lease: { holder: 'tab-a', expires_at: LEASE_EXPIRY },
  });
  const page = await getArtifactDoc('project-a', 'artifact-a', { after: 10, base: true });
  expect(page).toEqual({
    seeded: true,
    epoch: 'epoch-1',
    latest_seq: 12,
    updates: [{ seq: 11, update: bytes(1, 2, 3) }, { seq: 12, update: bytes(255) }],
    has_more: false,
    flushed: { seq: 10, version: 'entry-3', markdown: '# Plan\n' },
    lease: { holder: 'tab-a', expires_at: LEASE_EXPIRY },
  });
  expect(page.updates[0]!.update).toBeInstanceOf(Uint8Array);
  expect(calls).toEqual([{ url: `${doc}?after=10&base=true`, method: 'GET', body: undefined, authorization: 'Bearer person-token', keepalive: false }]);
});

test('getArtifactDoc defaults to after=0 without the base, and an unseeded doc reads as seeded false', async () => {
  reply = () => Response.json({ seeded: false, latest_seq: 0, updates: [], flushed: null, lease: null });
  expect(await getArtifactDoc('project-a', 'artifact-a')).toEqual({
    seeded: false, epoch: null, latest_seq: 0, updates: [], has_more: false, flushed: null, lease: null,
  });
  expect(calls.map((call) => call.url)).toEqual([`${doc}?after=0`]);
});

test('getArtifactDoc keeps has_more and a flushed state without markdown', async () => {
  reply = () => Response.json({ seeded: true, latest_seq: 900, updates: [{ seq: 500, update: 'AA==' }], has_more: true, flushed: { seq: 1, version: null }, lease: null });
  expect(await getArtifactDoc('project-a', 'artifact-a', { after: 0 })).toEqual({
    seeded: true, epoch: null, latest_seq: 900, updates: [{ seq: 500, update: bytes(0) }], has_more: true, flushed: { seq: 1, version: null }, lease: null,
  });
});

test('getArtifactDoc refuses an after that is not an integer ≥ 0, and a malformed page from the server', async () => {
  for (const after of [-1, 1.5, Number.NaN]) {
    await expect(getArtifactDoc('project-a', 'artifact-a', { after })).rejects.toThrow(RangeError);
  }
  expect(calls).toEqual([]);
  reply = () => Response.json({ seeded: true, latest_seq: 1, updates: [{ seq: 1, update: 'not base64!' }], flushed: null, lease: null });
  await expect(getArtifactDoc('project-a', 'artifact-a')).rejects.toThrow(TypeError);
  reply = () => Response.json({ seeded: true, latest_seq: 'x', updates: [], flushed: null, lease: null });
  await expect(getArtifactDoc('project-a', 'artifact-a')).rejects.toThrow(TypeError);
});

test('seedArtifactDoc posts the seed as base64 and returns its seq; 409 doc_seeded reaches the caller', async () => {
  reply = () => Response.json({ seq: 1, epoch: 'epoch-2' }, { status: 201 });
  expect(await seedArtifactDoc('project-a', 'artifact-a', { update: bytes(1, 2, 3, 4), markdown: '# Plan\n', version: 'entry-1' })).toEqual({ seq: 1, epoch: 'epoch-2' });
  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    { url: `${doc}/seed`, method: 'POST', body: { update: 'AQIDBA==', markdown: '# Plan\n', version: 'entry-1' } },
  ]);
  reply = () => Response.json({ error: 'The doc is already seeded', code: 'doc_seeded' }, { status: 409 });
  const error = await seedArtifactDoc('project-a', 'artifact-a', { update: bytes(1), markdown: '', version: 'entry-1' }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status: 409, code: 'doc_seeded' });
  expect(errors).toEqual([]);
});

test('pushArtifactDocUpdate posts one update as base64, with keepalive on request; each refusal keeps its status and code', async () => {
  expect(await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(9, 8))).toEqual({ seq: 7 });
  await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(1), { keepalive: true });
  expect(calls.map(({ url, method, body, keepalive }) => ({ url, method, body, keepalive }))).toEqual([
    { url: `${doc}/updates`, method: 'POST', body: { update: 'CQg=' }, keepalive: false },
    { url: `${doc}/updates`, method: 'POST', body: { update: 'AQ==' }, keepalive: true },
  ]);
  for (const [status, code] of [[409, 'doc_not_seeded'], [413, 'update_too_large'], [400, 'invalid_update'], [429, 'rate_limited']] as const) {
    reply = () => Response.json({ error: 'refused', code }, { status });
    const error = await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(1)).catch((caught: unknown) => caught);
    expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status, code });
  }
  expect(errors).toEqual([]);
});

test('leaseArtifactDoc acquires or renews with the holder, and releases with keepalive', async () => {
  reply = () => Response.json({ leader: true, holder: 'tab-a', expires_at: LEASE_EXPIRY });
  expect(await leaseArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a' })).toEqual({ leader: true, holder: 'tab-a', expires_at: LEASE_EXPIRY });
  reply = () => Response.json({ leader: false, holder: null, expires_at: null });
  expect(await leaseArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a', release: true }, { keepalive: true })).toEqual({ leader: false, holder: null, expires_at: null });
  expect(calls.map(({ url, method, body, keepalive }) => ({ url, method, body, keepalive }))).toEqual([
    { url: `${doc}/lease`, method: 'POST', body: { holder: 'tab-a' }, keepalive: false },
    { url: `${doc}/lease`, method: 'POST', body: { holder: 'tab-a', release: true }, keepalive: true },
  ]);
});

test('push, lease and flushed name the epoch the tab loaded, and leave it out when there is none', async () => {
  await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(1), { epoch: 'epoch-1' });
  await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(1), { epoch: null });
  reply = () => Response.json({ leader: true, holder: 'tab-a', expires_at: LEASE_EXPIRY });
  await leaseArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a', epoch: 'epoch-1' });
  await leaseArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a', release: true, epoch: 'epoch-1' }, { keepalive: true });
  reply = () => Response.json({ flushed_seq: 2 });
  await markArtifactDocFlushed('project-a', 'artifact-a', { holder: 'tab-a', seq: 2, version: 'entry-2', markdown: 'x', epoch: 'epoch-1' });
  expect(calls.map(({ url, body }) => ({ path: url.slice(doc.length), body }))).toEqual([
    { path: '/updates', body: { update: 'AQ==', epoch: 'epoch-1' } },
    { path: '/updates', body: { update: 'AQ==' } },
    { path: '/lease', body: { holder: 'tab-a', epoch: 'epoch-1' } },
    { path: '/lease', body: { holder: 'tab-a', release: true, epoch: 'epoch-1' } },
    { path: '/flushed', body: { holder: 'tab-a', seq: 2, version: 'entry-2', markdown: 'x', epoch: 'epoch-1' } },
  ]);
  reply = () => Response.json({ error: 'The doc was seeded again', code: 'epoch_mismatch' }, { status: 409 });
  const error = await pushArtifactDocUpdate('project-a', 'artifact-a', bytes(1), { epoch: 'epoch-0' }).catch((caught: unknown) => caught);
  expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status: 409, code: 'epoch_mismatch' });
});

test('resetArtifactDoc posts the holder to /doc/reset; 409 not_leader reaches the caller', async () => {
  reply = () => Response.json({ reset: true });
  expect(await resetArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a' })).toBeUndefined();
  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([{ url: `${doc}/reset`, method: 'POST', body: { holder: 'tab-a' } }]);
  reply = () => Response.json({ error: 'Another tab holds the lease', code: 'not_leader' }, { status: 409 });
  const error = await resetArtifactDoc('project-a', 'artifact-a', { holder: 'tab-a' }).catch((caught: unknown) => caught);
  expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status: 409, code: 'not_leader' });
  expect(errors).toEqual([]);
});

test('markArtifactDocFlushed posts the flushed seq, version and markdown; 409 not_leader reaches the caller', async () => {
  reply = () => Response.json({ flushed_seq: '42' });
  const flush = { holder: 'tab-a', seq: 42, version: 'entry-9', markdown: '# Plan\n\nDone.\n' };
  expect(await markArtifactDocFlushed('project-a', 'artifact-a', flush)).toEqual({ flushed_seq: 42 });
  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([{ url: `${doc}/flushed`, method: 'POST', body: flush }]);
  reply = () => Response.json({ error: 'Another tab holds the lease', code: 'not_leader' }, { status: 409 });
  const error = await markArtifactDocFlushed('project-a', 'artifact-a', flush).catch((caught: unknown) => caught);
  expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status: 409, code: 'not_leader' });
  expect(errors).toEqual([]);
});

test('the project facade binds the project id: artifacts.doc.get, .seed, .push, .lease, .flushed and .reset', async () => {
  const handle = createKortix({ backendUrl, getToken: async () => 'person-token' }).project('project-a');
  reply = () => Response.json({ seeded: false, latest_seq: 0, updates: [], flushed: null, lease: null });
  await handle.artifacts.doc.get('artifact-a', { after: 3 });
  reply = () => Response.json({ seq: 1 });
  await handle.artifacts.doc.seed('artifact-a', { update: bytes(1), markdown: '', version: 'entry-1' });
  await handle.artifacts.doc.push('artifact-a', bytes(2));
  reply = () => Response.json({ leader: true, holder: 'tab-a', expires_at: LEASE_EXPIRY });
  await handle.artifacts.doc.lease('artifact-a', { holder: 'tab-a' });
  reply = () => Response.json({ flushed_seq: 1 });
  await handle.artifacts.doc.flushed('artifact-a', { holder: 'tab-a', seq: 1, version: 'entry-2', markdown: 'x' });
  await handle.artifacts.doc.reset('artifact-a', { holder: 'tab-a' });
  expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
    `GET ${doc}?after=3`,
    `POST ${doc}/seed`,
    `POST ${doc}/updates`,
    `POST ${doc}/lease`,
    `POST ${doc}/flushed`,
    `POST ${doc}/reset`,
  ]);
});

test('the root entry exports the doc functions and the sync engine', () => {
  expect(typeof root.getArtifactDoc).toBe('function');
  expect(typeof root.seedArtifactDoc).toBe('function');
  expect(typeof root.pushArtifactDocUpdate).toBe('function');
  expect(typeof root.leaseArtifactDoc).toBe('function');
  expect(typeof root.markArtifactDocFlushed).toBe('function');
  expect(typeof root.resetArtifactDoc).toBe('function');
  expect(typeof root.createArtifactDocSync).toBe('function');
});
