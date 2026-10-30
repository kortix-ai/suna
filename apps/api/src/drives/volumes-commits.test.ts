import { afterEach, expect, mock, test } from 'bun:test';

const requests: Array<{ path: string; init: RequestInit }> = [];
let responses: unknown[] = [];
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    return Response.json(responses.shift());
  },
}));
const { commitVolumeUpload, getVolumeCommit, listVolumeCommits, parseVolumeWriteCommit, writeVolumeFile, writeVolumeFiles } = await import('./volumes');
const VOLUME = { name: 'volume', region: null, unfenced: true as const };

afterEach(() => { requests.length = 0; responses = []; });

test('direct Files writes preserve existing result fields and attach exact commit metadata', async () => {
  const commit = { commit_id: 'writer-one', outcome: 'merged' as const, head_commit_id: 'other-head' };
  responses = [{ path: '/Company/a.md', size: 3, version: 'etag-one', ...commit }];
  expect(await writeVolumeFile(VOLUME, '/Company/a.md', new Uint8Array([1, 2, 3]), { overwrite: true })).toEqual({
    path: '/Company/a.md', size: 3, version: 'etag-one', commit,
  });
});

test('upload commits preserve the complete provider response and batch writes return its writer commit', async () => {
  const raw = { commit_id: 'writer-one', outcome: 'fast', head_commit_id: 'writer-one', files: [{ path: '/a.md', version: 'etag' }], provider_extra: true };
  responses = [raw, { upload_id: 'upload-one', missing: [] }, raw];
  expect(await commitVolumeUpload(VOLUME, 'upload-one')).toEqual(raw);
  expect(await writeVolumeFiles(VOLUME, [{ path: '/a.md', bytes: new Uint8Array([1]) }], { overwrite: true })).toEqual(parseVolumeWriteCommit(raw));
  expect(await writeVolumeFiles(VOLUME, [], { overwrite: true })).toBeUndefined();
});

test('history requests preserve side, base, parent, and merge metadata', async () => {
  const commits = [{ id: 'head', kind: 'merge', author: { kind: 'system', id: null }, created_at: '2026-10-29T12:00:00.000Z',
    on_head: true, parent_id: 'before', base_id: 'base', merged_from: ['writer-one'] }];
  responses = [{ commits }];
  expect(await listVolumeCommits(VOLUME, 100, { includeSide: true, before: 'head' })).toEqual(commits);
  const query = new URL(requests[0]!.path, 'https://storage.invalid').searchParams;
  expect(query.get('include_side')).toBe('true');
  expect(query.get('limit')).toBe('100');
  expect(query.get('before')).toBe('head');
});

test('a merged writer can be read by its actual commit id without reading side file paths', async () => {
  const commit = { id: 'writer-one', kind: 'side', on_head: false, author: { kind: 'sandbox', id: 'sandbox-one' },
    created_at: '2026-10-29T12:00:00.000Z', parent_id: null, base_id: 'head-before', merged_from: [] };
  responses = [commit];
  expect(await getVolumeCommit(VOLUME, 'writer-one')).toEqual(commit);
  expect(requests[0]!.path.endsWith('/commits/writer-one')).toBe(true);
});
