import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  deleteDriveFile,
  downloadDriveFile,
  getDriveFileUrl,
  listDriveFiles,
  listDriveVersions,
  listSessionDrives,
  makeDriveFolder,
  moveDriveFile,
  restoreDriveVersion,
  uploadDriveFile,
} from './drives';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let next: { status: number; body: BodyInit | null; type: string } = { status: 200, body: '{}', type: 'application/json' };

function respond(status: number, body: unknown) {
  next = { status, body: JSON.stringify(body), type: 'application/json' };
}

beforeEach(() => {
  calls = [];
  respond(200, {});
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input instanceof Request ? input.url : input), method: init.method ?? 'GET', headers, body: init.body });
    return new Response(next.status === 204 ? null : next.body, { status: next.status, headers: { 'content-type': next.type } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const D = '11111111-2222-4333-8444-555555555555';

test('file operations encode the path in the query', async () => {
  respond(200, { entries: [{ path: '/a b', name: 'a b', type: 'dir', size: 0, mtime: 1 }] });
  const entries = await listDriveFiles(D, '/a b');
  expect(last().url).toBe(`http://test.local/drives/${D}/files?path=%2Fa+b`);
  expect(entries[0]!.type).toBe('dir');

  respond(200, { path: '/a b/x.txt', size: 3 });
  await uploadDriveFile(D, '/a b/x.txt', new Blob(['abc']));
  expect(last().method).toBe('PUT');
  expect(last().url).toBe(`http://test.local/drives/${D}/files/content?path=%2Fa+b%2Fx.txt`);
  expect(last().headers['content-type']).toBe('application/octet-stream');

  respond(200, { path: '/n' });
  await makeDriveFolder(D, '/n');
  expect(JSON.parse(String(last().body))).toEqual({ path: '/n' });

  respond(200, { from: '/n', to: '/m' });
  await moveDriveFile(D, '/n', '/m');
  expect(JSON.parse(String(last().body))).toEqual({ from: '/n', to: '/m' });

  next = { status: 204, body: null, type: '' };
  await deleteDriveFile(D, '/m', { recursive: true });
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/drives/${D}/files?path=%2Fm&recursive=true`]);
});

test('downloadDriveFile returns the bytes with the caller token and throws ApiError on failure', async () => {
  next = { status: 200, body: 'hello', type: 'application/octet-stream' };
  const blob = await downloadDriveFile(D, '/x.txt');
  expect(await blob.text()).toBe('hello');
  expect(last().url).toBe(`http://test.local/drives/${D}/files/content?path=%2Fx.txt`);
  expect(last().headers.authorization).toBe('Bearer tok');

  respond(404, { error: true, message: 'File or folder not found' });
  const err = await downloadDriveFile(D, '/gone').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(404);
});

test('getDriveFileUrl builds the content URL, with download when asked', () => {
  expect(getDriveFileUrl(D, '/r.pdf')).toBe(`http://test.local/drives/${D}/files/content?path=%2Fr.pdf`);
  expect(getDriveFileUrl(D, '/r.pdf', { download: true })).toBe(
    `http://test.local/drives/${D}/files/content?path=%2Fr.pdf&download=1`,
  );
});

test('versions, restore and session drives', async () => {
  respond(200, { versions: [{ id: 'c1', createdAt: 't', kind: 'edit', author: 'drive', changes: { changed: 1, deleted: 0 } }] });
  expect((await listDriveVersions(D))[0]!.id).toBe('c1');
  expect(last().url).toBe(`http://test.local/drives/${D}/versions`);

  next = { status: 204, body: null, type: '' };
  await restoreDriveVersion(D, 'c1');
  expect([last().method, last().url]).toEqual(['POST', `http://test.local/drives/${D}/restore`]);
  expect(JSON.parse(String(last().body))).toEqual({ versionId: 'c1' });

  respond(200, { drives: [{ driveId: D, name: 'Users / ana', kind: 'project', mountPath: '/drives/me', readOnly: false, subdir: '/Users/ana', role: 'me' }] });
  const mounted = await listSessionDrives('p1', 's1');
  expect(last().url).toBe('http://test.local/projects/p1/sessions/s1/drives');
  expect(mounted[0]!.mountPath).toBe('/drives/me');
});
