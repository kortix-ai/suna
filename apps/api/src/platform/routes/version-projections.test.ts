import { afterAll, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({ config: { SANDBOX_VERSION_OVERRIDE: 'dev-current' } }));
const originalFetch = globalThis.fetch;
const releases = [
  { tag_name: 'v2', name: 'Release two', published_at: '2026-10-25T12:00:00Z', body: 'notes', prerelease: false },
  { tag_name: 'v3-preview', name: '', published_at: null, body: null, prerelease: true },
  { tag_name: 'v1', name: '', published_at: null, body: '', prerelease: false },
];
const tags = [
  { name: 'dev-latest', last_updated: '2026-10-27T00:00:00Z' },
  { name: 'dev-current-amd64', last_updated: '2026-10-27T00:00:00Z' },
  { name: 'dev-current', last_updated: '2026-10-26T00:00:00Z' },
  ...Array.from({ length: 21 }, (_, i) => ({ name: `dev-${i}`, last_updated: null })),
];
globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
  return Response.json(String(input).startsWith('https://api.github.com/') ? releases : { results: tags });
}, { preconnect: originalFetch.preconnect });
afterAll(() => { globalThis.fetch = originalFetch; });
const { versionRouter } = await import('./version');

test('all and changelog retain complete release/tag projections, ordering and truncation', async () => {
  const allResponse = await versionRouter.request('/all');
  expect(allResponse.status).toBe(200);
  const all = await allResponse.json();
  expect(all.current).toEqual({ version: 'dev-current', channel: 'dev' });
  expect(all.versions).toEqual([
    { version: 'dev-current', channel: 'dev', date: '2026-10-26', title: 'Dev build current', sha: 'current', current: true },
    { version: '2', channel: 'stable', date: '2026-10-25', title: 'Release two', body: 'notes', current: false },
    { version: '3-preview', channel: 'dev', date: '', title: 'v3-preview', current: false },
    { version: '1', channel: 'stable', date: '', title: 'v1', current: false },
    ...Array.from({ length: 19 }, (_, i) => ({ version: `dev-${i}`, channel: 'dev', date: '', title: `Dev build ${i}`, sha: String(i), current: false })),
  ]);
  const changelogResponse = await versionRouter.request('/changelog');
  expect(changelogResponse.status).toBe(200);
  expect(await changelogResponse.json()).toEqual({ changelog: [
    { version: 'dev-current', channel: 'dev', date: '2026-10-26', title: 'Dev build current', sha: 'current', description: '', changes: [] },
    { version: '2', channel: 'stable', date: '2026-10-25', title: 'Release two', description: 'notes', changes: [] },
    { version: '1', channel: 'stable', date: '', title: 'v1', description: '', changes: [] },
    ...Array.from({ length: 19 }, (_, i) => ({ version: `dev-${i}`, channel: 'dev', date: '', title: `Dev build ${i}`, sha: String(i), description: '', changes: [] })),
  ] });
  const stable = await versionRouter.request('/changelog?channel=stable');
  expect((await stable.json()).changelog).toHaveLength(2);
  const dev = await versionRouter.request('/changelog?channel=dev');
  expect((await dev.json()).changelog).toHaveLength(20);
});
