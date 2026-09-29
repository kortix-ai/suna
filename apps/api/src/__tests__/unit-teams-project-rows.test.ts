import { afterAll, describe, expect, mock, test } from 'bun:test';

// On dev (2026-09-29) `/projects` and `/sessions` drew a broken image beside a
// Kortix-hosted project, with its internal repo name `managed-kortix/<slug>-<id>`
// under it. A row now shows a preview only when it loads, and a hosted repo
// by what it is.

mock.module('../config', () => ({ config: { FRONTEND_URL: 'https://app.example.test', MANAGED_GIT_GITHUB_OWNER: 'managed-kortix' } }));
const calls: string[][] = [];
const realRepoPreview = await import('../channels/repo-preview');
mock.module('../channels/repo-preview', () => ({
  ...realRepoPreview,
  repoPreviewImages: async (urls: Iterable<string | null | undefined>) => {
    const list = [...urls].filter((u): u is string => Boolean(u));
    calls.push(list);
    return new Map(list.filter((u) => u.includes('/octocat/')).map((u) => [u, `https://opengraph.githubassets.com/1/${u.split('github.com/')[1]}`]));
  },
}));
const { projectRows } = await import('../channels/teams/project-rows');
afterAll(() => mock.restore());

describe('projectRows', () => {
  test('a hosted repo reads "Hosted by Kortix" with no image; a public one keeps its name and preview; a private one has no image', async () => {
    const rows = await projectRows([
      { projectId: 'p1', name: 'Hosted', repoUrl: 'https://github.com/managed-kortix/hosted-11111111-1111-4111-8111-111111111111' },
      { projectId: 'p2', name: 'Public', repoUrl: 'https://github.com/octocat/Hello-World' },
      { projectId: 'p3', name: 'Private', repoUrl: 'https://github.com/acme/private-app' },
      { projectId: 'p4', name: 'No repo', repoUrl: null },
    ], 'p2');
    expect(rows.map((r) => [r.name, r.repo, r.imageUrl, r.current])).toEqual([
      ['Hosted', 'Hosted by Kortix', null, false],
      ['Public', 'octocat/Hello-World', 'https://opengraph.githubassets.com/1/octocat/Hello-World', true],
      ['Private', 'acme/private-app', null, false],
      ['No repo', null, null, false],
    ]);
    expect(rows[1]!.url).toBe('https://app.example.test/projects/p2');
    // One check for the whole card, not one per row.
    expect(calls).toHaveLength(1);
  });
});
