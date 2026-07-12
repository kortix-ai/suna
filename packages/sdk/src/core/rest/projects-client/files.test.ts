import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listProjectFiles } from './files';

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

test('listProjectFiles GETs /projects/:id/files with ref/path query', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listProjectFiles('P1', { ref: 'main', path: 'src' });
  expect(last().url).toContain('/projects/P1/files?ref=main&path=src');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listProjectFiles is a silent background read — a 403 never hits the global error sink', async () => {
  // project.file.read is editor-tier: a member deep-linking to the files page
  // legitimately 403s. The files view renders its own error state, no toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(listProjectFiles('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});
