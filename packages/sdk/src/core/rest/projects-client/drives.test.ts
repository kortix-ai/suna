import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  attachSessionDrive,
  createDrive,
  deleteDrive,
  detachSessionDrive,
  dismissDriveConflict,
  getSessionDrives,
  listDriveConflicts,
  listDriveGrants,
  removeDriveGrant,
  setSessionDriveAccess,
  deleteDriveFile,
  downloadDriveFile,
  getDriveFileUrl,
  grantDrive,
  listDriveFiles,
  listDrives,
  listDriveVersions,
  listSessionDrives,
  makeDriveFolder,
  moveDriveFile,
  renameDrive,
  restoreDriveVersion,
  revokeDrive,
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

test('listDrives scopes by project, or by account', async () => {
  respond(200, { drives: [{ driveId: D, kind: 'personal', name: 'My Drive' }] });
  const drives = await listDrives({ projectId: 'p1' });
  expect(last().url).toBe('http://test.local/drives?projectId=p1');
  expect(drives[0]!.driveId).toBe(D);
  await listDrives({ accountId: 'a1' });
  expect(last().url).toBe('http://test.local/drives?account_id=a1');
  await listDrives();
  expect(last().url).toBe('http://test.local/drives');
});

test('createDrive, renameDrive and deleteDrive send the documented bodies', async () => {
  respond(201, { driveId: D, kind: 'company', name: 'Team' });
  expect((await createDrive({ name: 'Team', kind: 'company', accountId: 'a1' })).driveId).toBe(D);
  expect(last().method).toBe('POST');
  expect(JSON.parse(String(last().body))).toEqual({ name: 'Team', kind: 'company', account_id: 'a1' });

  respond(200, { driveId: D, name: 'Docs' });
  await renameDrive(D, 'Docs');
  expect([last().method, last().url]).toEqual(['PATCH', `http://test.local/drives/${D}`]);
  expect(JSON.parse(String(last().body))).toEqual({ name: 'Docs' });

  next = { status: 204, body: null, type: '' };
  await deleteDrive(D);
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/drives/${D}`]);
});

test('grantDrive grants to a project, a person or an agent; revokeDrive names the subject', async () => {
  respond(200, { grantId: 'g1', type: 'project', projectId: 'p1', access: 'read' });
  expect((await grantDrive(D, { type: 'project', projectId: 'p1' }, 'read')).access).toBe('read');
  expect(last().url).toBe(`http://test.local/drives/${D}/grants`);
  expect(JSON.parse(String(last().body))).toEqual({ type: 'project', projectId: 'p1', access: 'read' });
  await grantDrive(D, { type: 'user', userId: 'u1' });
  expect(JSON.parse(String(last().body))).toEqual({ type: 'user', userId: 'u1', access: 'write' });
  await grantDrive(D, { type: 'agent', projectId: 'p1', agentName: 'kortix' }, 'write');
  expect(JSON.parse(String(last().body))).toEqual({ type: 'agent', projectId: 'p1', agentName: 'kortix', access: 'write' });

  next = { status: 204, body: null, type: '' };
  await revokeDrive(D, { type: 'project', projectId: 'p1' });
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/drives/${D}/grants?projectId=p1`]);
  await revokeDrive(D, { type: 'agent', projectId: 'p1', agentName: 'a b' });
  expect(last().url).toBe(`http://test.local/drives/${D}/grants?projectId=p1&agentName=a+b`);
  await revokeDrive(D, { type: 'user', userId: 'u1' });
  expect(last().url).toBe(`http://test.local/drives/${D}/grants?userId=u1`);
  await removeDriveGrant(D, 'g1');
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/drives/${D}/grants/g1`]);

  respond(200, { grants: [{ grantId: 'g1', type: 'user', userEmail: 'a@b.c', access: 'read' }] });
  expect((await listDriveGrants(D))[0]!.userEmail).toBe('a@b.c');
  expect(last().url).toBe(`http://test.local/drives/${D}/grants`);
});

test('conflicts are listed and dismissed per drive', async () => {
  respond(200, { conflicts: [{ conflictId: 'c1', path: '/a (conflict 2026-10-01 1405).md', originalPath: '/a.md', detectedAt: 't' }] });
  expect((await listDriveConflicts(D))[0]!.originalPath).toBe('/a.md');
  expect(last().url).toBe(`http://test.local/drives/${D}/conflicts`);
  next = { status: 204, body: null, type: '' };
  await dismissDriveConflict(D, 'c1');
  expect([last().method, last().url]).toEqual(['POST', `http://test.local/drives/${D}/conflicts/c1/dismiss`]);
});

test('session drives: read, attach, detach and switch access', async () => {
  const body = { drives: [{ driveId: D, name: 'Brand', kind: 'company', mountPath: '/drives/brand', readOnly: true, openConflicts: 0 }], personal: true, live: true };
  respond(200, body);
  expect((await getSessionDrives('p1', 's1')).personal).toBe(true);
  expect(last().url).toBe('http://test.local/projects/p1/sessions/s1/drives');

  const attached = await attachSessionDrive('p1', 's1', { driveId: D, readOnly: true });
  expect([last().method, last().url]).toEqual(['POST', 'http://test.local/projects/p1/sessions/s1/drives']);
  expect(JSON.parse(String(last().body))).toEqual({ driveId: D, readOnly: true });
  expect(attached.live).toBe(true);

  await detachSessionDrive('p1', 's1', D);
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/projects/p1/sessions/s1/drives/${D}`]);

  await setSessionDriveAccess('p1', 's1', D, 'write');
  expect([last().method, last().url]).toEqual(['PATCH', `http://test.local/projects/p1/sessions/s1/drives/${D}`]);
  expect(JSON.parse(String(last().body))).toEqual({ access: 'write' });
});

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

  respond(200, { driveId: D });
  await restoreDriveVersion(D, 'c1');
  expect([last().method, last().url]).toEqual(['POST', `http://test.local/drives/${D}/restore`]);
  expect(JSON.parse(String(last().body))).toEqual({ versionId: 'c1' });

  respond(200, { drives: [{ driveId: D, name: 'My Drive', kind: 'personal', mountPath: '/drives/me', readOnly: false }] });
  const mounted = await listSessionDrives('p1', 's1');
  expect(last().url).toBe('http://test.local/projects/p1/sessions/s1/drives');
  expect(mounted[0]!.mountPath).toBe('/drives/me');
});
