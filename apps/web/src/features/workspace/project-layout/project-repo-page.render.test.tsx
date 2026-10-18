import { expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@kortix/sdk/react', () => ({ useFeatureFlag: () => ({ enabled: true }) }));
mock.module('@/lib/use-permission', () => ({
  useCan: () => ({ allowed: true, isLoading: false, isError: false, reason: null }),
  useCans: (_input: unknown, actions: readonly string[]) => Object.fromEntries(actions.map((action) => [action,
    { allowed: true, isLoading: false, isError: false, reason: null },
  ])),
}));
mock.module('@/components/ui/sidebar', () => ({ useOptionalSidebar: () => null }));
mock.module('./sidebar-toggle', () => ({ SidebarToggle: () => <button>Open sidebar</button> }));
mock.module('./project-files-view', () => ({
  ProjectFilesView: ({ tabs }: { tabs?: { label: string }[] }) => <main data-explorer-tabs={tabs?.map((tab) => tab.label).join(',')}>Explorer</main>,
}));
mock.module('@/features/workspace/customize/sections/view/review-view', () => ({ ReviewView: () => <main>Review inbox</main> }));
const { ProjectRepoPage } = await import('./project-repo-page');

test('Repo delegates its header tabs to the explorer instead of adding a second header', () => {
  const html = renderToStaticMarkup(<ProjectRepoPage projectId="p1" section="repo" />);
  expect(html).not.toContain('kx-capability-titlebar');
  expect(html).toContain('data-explorer-tabs="Repo,Review"');
});

test('Review keeps the wrapper header and both section links', () => {
  const html = renderToStaticMarkup(<ProjectRepoPage projectId="p1" section="review" />);
  expect(html.match(/kx-capability-titlebar/g)).toHaveLength(1);
  expect(html).toContain('href="/projects/p1/files"');
  expect(html).toContain('href="/projects/p1/files/review"');
  expect(html).toContain('Review inbox');
  expect(html).not.toContain('data-explorer-tabs');
});
