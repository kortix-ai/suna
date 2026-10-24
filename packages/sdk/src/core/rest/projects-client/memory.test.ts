import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  addProjectMemoryNote,
  createProjectMemoryPage,
  deleteProjectMemoryPage,
  getProjectMemoryLayer,
  getProjectMemoryPage,
  getSessionMemoryUsage,
  listProjectMemoryChanges,
  listProjectMemoryHistory,
  listProjectMemoryPages,
  searchProjectMemory,
  undoProjectMemoryVersion,
  updateProjectMemoryPage,
  type ProjectMemoryLayer,
  type ProjectMemoryPage,
  type ProjectMemorySearchHit,
  type SessionMemoryUsage,
} from './memory';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
let hostErrors: unknown[] = [];

beforeEach(() => {
  calls = [];
  hostErrors = [];
  nextResponse = { status: 200, body: {} };
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => hostErrors.push(e) });
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const SPACE = '00000000-0000-4000-8000-000000000001';
const PAGE = '00000000-0000-4000-8000-0000000000a1';
const VERSION = '00000000-0000-4000-8000-0000000000b1';
const base = 'http://test.local/v1/projects/P1/memory';

const layer: ProjectMemoryLayer = {
  layer_id: '00000000-0000-4000-8000-0000000000c1',
  scope: 'channel',
  space_id: SPACE,
  name: '#launch',
  counts: { people: 1, decisions: 0, workstreams: 1, playbooks: 0, note: 0, other: 2, unconfirmed: 0, trash: 0 },
  read_only: false,
  can_write: true,
  folder: '/Company/Channels/launch/Memory',
  agent_folder: null,
  drive_id: '00000000-0000-4000-8000-0000000000d1',
  other_files: 1,
};

const page: ProjectMemoryPage = {
  page_id: PAGE,
  layer_id: layer.layer_id,
  type: 'people',
  title: 'Priya',
  summary: 'Runs the Northwind launch',
  status: 'confirmed',
  updated_at: '2026-10-23T00:00:00.000Z',
  updated_by: { kind: 'person', user_id: 'U1', name: 'Priya', agent: null },
  updated_source: null,
  path: '/Company/Channels/launch/Memory/people/priya.md',
  body: '## Role\n- Owns the launch [1]',
  sources: [
    { number: 1, kind: 'person', session_id: null, message_id: null, label: 'Priya', url: null, thread_href_hint: null },
  ],
  related: [],
  version_no: 3,
  can_edit: true,
  can_delete: true,
};

test('getProjectMemoryLayer GETs the layer by key', async () => {
  nextResponse = { status: 200, body: layer };
  expect(await getProjectMemoryLayer('P1', SPACE)).toEqual(layer);
  expect(calls).toEqual([{ url: `${base}/layers/${SPACE}`, method: 'GET', body: undefined }]);
});

test('getProjectMemoryLayer reaches the Company layer by the key company', async () => {
  nextResponse = { status: 200, body: { ...layer, scope: 'company', space_id: null, name: 'Company' } };
  await getProjectMemoryLayer('P1', 'company');
  expect(calls[0]!.url).toBe(`${base}/layers/company`);
});

test('listProjectMemoryPages GETs the layer pages and returns the array', async () => {
  const { body: _b, sources: _s, related: _r, version_no: _v, can_edit: _e, can_delete: _d, ...summary } = page;
  nextResponse = { status: 200, body: { pages: [summary], truncated: false } };
  expect(await listProjectMemoryPages('P1', 'company')).toEqual([summary]);
  expect(calls).toEqual([{ url: `${base}/layers/company/pages`, method: 'GET', body: undefined }]);
});

test('listProjectMemoryPages filters by type and status', async () => {
  nextResponse = { status: 200, body: { pages: [], truncated: false } };
  await listProjectMemoryPages('P1', SPACE, { type: 'other' });
  await listProjectMemoryPages('P1', SPACE, { type: 'people', status: 'unconfirmed' });
  expect(calls.map((c) => c.url)).toEqual([`${base}/layers/${SPACE}/pages?type=other`, `${base}/layers/${SPACE}/pages?type=people&status=unconfirmed`]);
});

test('createProjectMemoryPage POSTs the input to the layer pages', async () => {
  nextResponse = { status: 201, body: page };
  const input = { type: 'people' as const, title: 'Priya', summary: 'Runs the Northwind launch' };
  expect(await createProjectMemoryPage('P1', SPACE, input)).toEqual(page);
  expect(calls).toEqual([{ url: `${base}/layers/${SPACE}/pages`, method: 'POST', body: input }]);
});

test('addProjectMemoryNote POSTs the sentence to the layer notes', async () => {
  nextResponse = { status: 201, body: { ...page, type: 'note' } };
  const note = await addProjectMemoryNote('P1', SPACE, { text: 'Priya owns the launch', source_session_id: 'T1' });
  expect(note.type).toBe('note');
  expect(calls).toEqual([
    { url: `${base}/layers/${SPACE}/notes`, method: 'POST', body: { text: 'Priya owns the launch', source_session_id: 'T1' } },
  ]);
});

test('listProjectMemoryChanges GETs Recent changes of the layer with its next cursor', async () => {
  nextResponse = { status: 200, body: { changes: [], next: 'C2' } };
  expect(await listProjectMemoryChanges('P1', SPACE)).toEqual({ changes: [], next: 'C2' });
  expect(calls).toEqual([{ url: `${base}/layers/${SPACE}/changes`, method: 'GET', body: undefined }]);
});

test('listProjectMemoryChanges passes limit and the before cursor', async () => {
  nextResponse = { status: 200, body: { changes: [], next: null } };
  await listProjectMemoryChanges('P1', SPACE, { limit: 20, before: 'C2' });
  expect(calls[0]!.url).toBe(`${base}/layers/${SPACE}/changes?limit=20&before=C2`);
});

test('getProjectMemoryPage GETs one page by id', async () => {
  nextResponse = { status: 200, body: page };
  expect(await getProjectMemoryPage('P1', PAGE)).toEqual(page);
  expect(calls).toEqual([{ url: `${base}/pages/${PAGE}`, method: 'GET', body: undefined }]);
});

test('updateProjectMemoryPage PATCHes the page with its base_version', async () => {
  nextResponse = { status: 200, body: { ...page, version_no: 4 } };
  const updated = await updateProjectMemoryPage('P1', PAGE, { base_version: 3, body: '## Role\n- Owns QA' });
  expect(updated.version_no).toBe(4);
  expect(calls).toEqual([
    { url: `${base}/pages/${PAGE}`, method: 'PATCH', body: { base_version: 3, body: '## Role\n- Owns QA' } },
  ]);
});

test('deleteProjectMemoryPage DELETEs the page and returns the version to undo', async () => {
  nextResponse = { status: 200, body: { ok: true, version_id: VERSION } };
  expect(await deleteProjectMemoryPage('P1', PAGE)).toEqual({ ok: true, version_id: VERSION });
  expect(calls).toEqual([{ url: `${base}/pages/${PAGE}`, method: 'DELETE', body: undefined }]);
});

test('listProjectMemoryHistory GETs the page history with its next cursor', async () => {
  nextResponse = { status: 200, body: { versions: [], next: null } };
  expect(await listProjectMemoryHistory('P1', PAGE)).toEqual({ versions: [], next: null });
  expect(calls).toEqual([{ url: `${base}/pages/${PAGE}/history`, method: 'GET', body: undefined }]);
});

test('listProjectMemoryHistory passes the before cursor', async () => {
  nextResponse = { status: 200, body: { versions: [], next: null } };
  await listProjectMemoryHistory('P1', PAGE, { before: 'V9' });
  expect(calls[0]!.url).toBe(`${base}/pages/${PAGE}/history?before=V9`);
});

test('undoProjectMemoryVersion POSTs to the version undo and returns every page the undo changed', async () => {
  nextResponse = { status: 200, body: { pages: [page] } };
  expect(await undoProjectMemoryVersion('P1', VERSION)).toEqual({ pages: [page] });
  expect(calls).toEqual([{ url: `${base}/versions/${VERSION}/undo`, method: 'POST', body: undefined }]);
});

const hit: ProjectMemorySearchHit = {
  page_id: PAGE,
  layer_key: SPACE,
  layer_name: '#launch',
  scope: 'channel',
  type: 'people',
  title: 'Priya',
  summary: 'Runs the Northwind launch',
  snippet: 'Owns the launch',
  status: 'confirmed',
};

test('searchProjectMemory GETs memory/search with q and returns the hits', async () => {
  nextResponse = { status: 200, body: { hits: [hit] } };
  expect(await searchProjectMemory('P1', { q: 'Priya' })).toEqual({ hits: [hit] });
  expect(calls).toEqual([{ url: `${base}/search?q=Priya`, method: 'GET', body: undefined }]);
});

test('searchProjectMemory passes layer, type and limit, and encodes q', async () => {
  nextResponse = { status: 200, body: { hits: [] } };
  await searchProjectMemory('P1', { q: 'launch & QA', layer: 'company', type: 'decisions', limit: 5 });
  expect(calls[0]!.url).toBe(`${base}/search?q=launch+%26+QA&layer=company&type=decisions&limit=5`);
});

test('getSessionMemoryUsage GETs the thread memory-usage route', async () => {
  const usage: SessionMemoryUsage = {
    loaded_at: '2026-10-23T00:00:00.000Z',
    layers: [{ layer_key: 'company', scope: 'company', name: 'Company', pages: [{ page_id: PAGE, type: 'people', title: 'Priya' }] }],
  };
  nextResponse = { status: 200, body: usage };
  expect(await getSessionMemoryUsage('P1', 'T1')).toEqual(usage);
  expect(calls).toEqual([{ url: 'http://test.local/v1/projects/P1/sessions/T1/memory-usage', method: 'GET', body: undefined }]);
});

test.each([
  ['searchProjectMemory', 400, 'invalid_input', () => searchProjectMemory('P1', { q: 'x' })],
  ['getSessionMemoryUsage', 404, 'session_not_found', () => getSessionMemoryUsage('P1', 'T1')],
  ['updateProjectMemoryPage', 409, 'version_conflict', () => updateProjectMemoryPage('P1', PAGE, { base_version: 2, body: 'x' })],
  ['createProjectMemoryPage', 409, 'title_taken', () => createProjectMemoryPage('P1', SPACE, { type: 'people', title: 'Priya' })],
  ['createProjectMemoryPage', 413, 'page_too_large', () => createProjectMemoryPage('P1', SPACE, { type: 'playbooks', title: 'Big', body: 'x' })],
  ['addProjectMemoryNote', 422, 'secret_detected', () => addProjectMemoryNote('P1', SPACE, { text: 'a key' })],
  ['undoProjectMemoryVersion', 409, 'superseded', () => undoProjectMemoryVersion('P1', VERSION)],
  ['getProjectMemoryLayer', 404, 'memory_not_found', () => getProjectMemoryLayer('P1', SPACE)],
  ['undoProjectMemoryVersion', 404, 'version_gone', () => undoProjectMemoryVersion('P1', VERSION)],
  ['getProjectMemoryLayer', 503, 'drive_storage_unavailable', () => getProjectMemoryLayer('P1', 'company')],
] as const)('%s rejects %i with ApiError code %s and never reaches the host error handler', async (_name, status, code, call) => {
  nextResponse = { status, body: { error: 'rejected', code, page_id: PAGE } };
  const error = await call().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  expect(hostErrors).toEqual([]);
});
