import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listWorkspaceFiles, readWorkspaceFile } from './files';

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

test('listWorkspaceFiles GETs /workspaces/:id/files with ref/path query', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listWorkspaceFiles('P1', { ref: 'main', path: 'src' });
  expect(last().url).toContain('/workspaces/P1/files?ref=main&path=src');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listWorkspaceFiles is a silent background read — a 403 never hits the global error sink', async () => {
  // workspace.file.read is editor-tier: a member deep-linking to the files page
  // legitimately 403s. The files view renders its own error state, no toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(listWorkspaceFiles('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('readWorkspaceFile GETs /workspaces/:id/files/content with path/ref query', async () => {
  nextResponse = { status: 200, body: { path: 'a.md', ref: 'main', content: 'hi' } };
  const result = await readWorkspaceFile('P1', 'a.md', 'main');
  expect(last().url).toContain('/workspaces/P1/files/content?path=a.md&ref=main');
  expect(last().method).toBe('GET');
  expect(result.content).toBe('hi');
});

test('readWorkspaceFile is a silent background read — a 403 never hits the global error sink', async () => {
  // Same editor-tier gate as listWorkspaceFiles above, same reason: a workspace
  // detail/skill/command modal reading one file legitimately 403s for a
  // plain member, and renders its own inline error state — never a toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(readWorkspaceFile('P1', 'a.md')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});
