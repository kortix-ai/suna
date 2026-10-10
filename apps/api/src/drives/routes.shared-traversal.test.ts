/**
 * A member given read on a folder inside someone else's private folder
 * (`/Users/admin/x`) must be able to walk to it: `/Users` and `/Users/admin`
 * open for traversal and list only the way there, the shared folder lists and
 * reads, and nothing else in the owner's folder shows. Files also names the
 * folders shared with the caller, for the "Shared with me" shortcut.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import type { FolderGrant } from './folders';

const DRIVE_ID = '6f0c2a52-6f39-4c2b-9f43-5b0a7a1d2e11';
const PROJECT_ID = '0d1e6a3c-3c55-4a8e-8d0e-2f1b6c3d4e5f';
const ACCOUNT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';

let caller = ANA;

type Entry = { path: string; type: 'file' | 'dir'; size: number; mtime: number };
const dir = (path: string): Entry => ({ path, type: 'dir', size: 0, mtime: 0 });
const file = (path: string): Entry => ({ path, type: 'file', size: 5, mtime: 0 });
const TREE: Record<string, Entry[]> = {
  '/': [dir('/Users'), dir('/Company')],
  '/Users': [dir('/Users/admin'), dir('/Users/ana'), dir('/Users/bob')],
  '/Users/admin': [dir('/Users/admin/x'), dir('/Users/admin/other'), file('/Users/admin/secret.txt')],
  '/Users/admin/x': [file('/Users/admin/x/report.txt')],
  '/Users/admin/other': [file('/Users/admin/other/plan.txt')],
  '/Users/bob': [file('/Users/bob/diary.txt')],
  '/Users/ana': [file('/Users/ana/notes.txt')],
};
const writes: string[] = [];

const GRANTS: FolderGrant[] = [
  { grantId: 'g1', path: '/Users/admin', level: 'manage', principalType: 'user', principalId: ADMIN, source: 'system' },
  { grantId: 'g2', path: '/Users/ana', level: 'manage', principalType: 'user', principalId: ANA, source: 'system' },
  { grantId: 'g3', path: '/Users/bob', level: 'manage', principalType: 'user', principalId: BOB, source: 'system' },
  { grantId: 'g4', path: '/Users/admin/x', level: 'read', principalType: 'user', principalId: ANA, source: 'user' },
];

const DRIVE = {
  driveId: DRIVE_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  kind: 'project',
  name: 'Files',
  platinumVolumeId: 'vol-1',
  platinumVolumeName: 'vol-1',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const realAuth = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuth,
  combinedAuth: async (c: any, next: () => Promise<void>) => {
    c.set('userId', caller);
    c.set('authType', 'jwt');
    await next();
  },
}));
const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  // Ana and Bob work in the project; only the admin may change it.
  loadProjectForUser: async (c: any, _projectId: string, action: string) => {
    if (action === 'write' && c.get('userId') !== ADMIN) throw new HTTPException(403, { message: 'no' });
    return { row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: {} } };
  },
}));
const realGate = await import('../feature-flags/gate');
mock.module('../feature-flags/gate', () => ({ ...realGate, requireFeatureFlag: () => null }));
const realService = await import('./service');
mock.module('./service', () => ({
  ...realService,
  getDrive: async () => DRIVE,
  ensureProjectDrive: async () => DRIVE,
  listFolderGrants: async () => GRANTS,
  ensurePersonalFolder: async (_drive: unknown, userId: string) =>
    userId === ADMIN ? '/Users/admin' : userId === ANA ? '/Users/ana' : '/Users/bob',
  groupIdsOf: async () => new Set<string>(),
  driveStats: async () => null,
  openConflictRows: async () => [],
  readDriveVolume: async (_drive: unknown, op: (volume: string) => Promise<unknown>) => op('vol-1'),
  writeDriveVolume: async (_drive: unknown, op: (volume: string) => Promise<unknown>) => op('vol-1'),
}));
const realConflicts = await import('./conflicts');
mock.module('./conflicts', () => ({ ...realConflicts, noteDriveWrite: () => undefined }));
// The storage behind a drive file, as the volume API keeps it: a write with
// If-Match lands only while the file is at that version, in one step.
const stored = { version: 'v1', body: 'original' };
let held: Array<() => void> = [];
let holdWrites = 0;
const realPlatinum = await import('../shared/platinum');
mock.module('../shared/platinum', () => ({
  ...realPlatinum,
  isPlatinumConfigured: () => true,
  platinumFetch: async (_path: string, init: RequestInit = {}) => {
    // Hold writes until `holdWrites` of them have arrived: both saves have
    // passed every check that comes before the write.
    if (holdWrites > 0) {
      await new Promise<void>((resolve) => {
        held.push(resolve);
        if (held.length === holdWrites) for (const go of held) go();
      });
    }
    const ifMatch = new Headers(init.headers).get('if-match');
    if (ifMatch && ifMatch.replace(/"/g, '') !== stored.version) {
      return Response.json({ code: 'precondition_failed', error: 'stale' }, { status: 412 });
    }
    stored.body = new TextDecoder().decode(init.body as Uint8Array);
    stored.version = `v${Number(stored.version.slice(1)) + 1}`;
    return Response.json({ path: '/Users/ana/notes.txt', size: stored.body.length, version: stored.version }, { status: 201 });
  },
}));
const realVolumes = await import('./volumes');
const realWriteVolumeFile = realVolumes.writeVolumeFile;
mock.module('./volumes', () => ({
  ...realVolumes,
  listVolumeFiles: async (_volume: string, path: string) => {
    const entries = TREE[path];
    if (!entries) throw new realVolumes.DriveStorageError(404, 'File or folder not found');
    return entries;
  },
  readVolumeFile: async (_volume: string, path: string) => {
    const known = Object.values(TREE).flat().some((e) => e.path === path && e.type === 'file');
    if (!known) throw new realVolumes.DriveStorageError(404, 'File or folder not found');
    const etag = path === '/Users/ana/notes.txt' ? stored.version : 'v1';
    return new Response(`bytes of ${path}`, { headers: { etag: `"${etag}"` } });
  },
  writeVolumeFile: async (...args: Parameters<typeof realWriteVolumeFile>) => {
    writes.push(args[1]);
    return realWriteVolumeFile(...args);
  },
}));

const { drivesApp } = await import('./routes');

async function list(path: string) {
  const res = await drivesApp.request(`/${DRIVE_ID}/files?${new URLSearchParams({ path })}`);
  const body = (await res.json()) as { entries?: Array<{ path: string }>; access?: string };
  return { status: res.status, access: body.access, paths: (body.entries ?? []).map((e) => e.path).sort() };
}

beforeEach(() => {
  caller = ANA;
  writes.length = 0;
  Object.assign(stored, { version: 'v1', body: 'original' });
  held = [];
  holdWrites = 0;
});

describe('a member walking to a folder shared from a private folder', () => {
  test('/Users opens and lists only the way to the share and their own folder', async () => {
    expect(await list('/Users')).toEqual({ status: 200, access: 'none', paths: ['/Users/admin', '/Users/ana'] });
  });

  test('the owner’s folder lists only the shared folder', async () => {
    expect(await list('/Users/admin')).toEqual({ status: 200, access: 'none', paths: ['/Users/admin/x'] });
  });

  test('the shared folder lists and its files read', async () => {
    expect(await list('/Users/admin/x')).toEqual({ status: 200, access: 'read', paths: ['/Users/admin/x/report.txt'] });
    const res = await drivesApp.request(`/${DRIVE_ID}/files/content?path=/Users/admin/x/report.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('bytes of /Users/admin/x/report.txt');
  });

  test('everything else stays hidden', async () => {
    expect((await list('/Users/bob')).status).toBe(404);
    expect((await list('/Users/admin/other')).status).toBe(404);
    for (const path of ['/Users/admin/secret.txt', '/Users/admin/other/plan.txt', '/Users/bob/diary.txt']) {
      const res = await drivesApp.request(`/${DRIVE_ID}/files/content?${new URLSearchParams({ path })}`);
      expect(res.status).toBe(404);
    }
  });

  test('Files names the folders shared with the caller', async () => {
    const res = await drivesApp.request(`/?projectId=${PROJECT_ID}`);
    const body = (await res.json()) as { drives: Array<{ sharedWithMe?: unknown }> };
    expect(body.drives[0]!.sharedWithMe).toEqual([{ path: '/Users/admin/x', access: 'read' }]);

    caller = BOB;
    const bob = (await (await drivesApp.request(`/?projectId=${PROJECT_ID}`)).json()) as typeof body;
    expect(bob.drives[0]!.sharedWithMe).toEqual([]);
  });
});

describe('saving an edit from the Files viewer', () => {
  const put = (ifMatch?: string, body = 'edited') =>
    drivesApp.request(`/${DRIVE_ID}/files/content?path=/Users/ana/notes.txt`, {
      method: 'PUT',
      body,
      headers: ifMatch ? { 'if-match': ifMatch } : {},
    });

  test('a save at the version it read writes', async () => {
    const res = await put('"v1"');
    expect(res.status).toBe(200);
    expect(writes).toEqual(['/Users/ana/notes.txt']);
  });

  test('a save over a file changed since it was read is refused, not written', async () => {
    const res = await put('"v0"');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('file_changed');
    expect(writes).toEqual([]);
  });

  test('two saves from the same version: one lands, the other is refused and the first edit is kept', async () => {
    holdWrites = 2;
    const [a, b] = await Promise.all([put('"v1"', 'edit A'), put('"v1"', 'edit B')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(((await refused.json()) as { code?: string }).code).toBe('file_changed');
    const landed = a.status === 200 ? a : b;
    expect(stored.body).toBe(landed === a ? 'edit A' : 'edit B');
    expect(landed.headers.get('etag')).toBe('"v2"');
  });
});
