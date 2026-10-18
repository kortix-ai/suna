import { expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ useParams: () => ({ id: 'p1' }) }));
mock.module('@kortix/sdk/react', () => ({ useFeatureFlag: () => ({ enabled: true }) }));
mock.module('@/components/ui/sidebar', () => ({ useOptionalSidebar: () => null }));
mock.module('@/features/workspace/project-layout/sidebar-toggle', () => ({ SidebarToggle: () => <button>Open sidebar</button> }));
mock.module('./version-selector', () => ({ VersionSelector: () => <button>main version</button> }));
mock.module('./drive-toolbar', () => ({
  DrivePathBar: () => <nav>src folder</nav>,
  DriveViewMenu: () => <button>Explorer menu</button>,
}));
mock.module('@/components/ui/hint', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
const { DriveHeader } = await import('./drive-header');

test('standalone explorer puts Repo/Review tabs and existing actions in one title bar', () => {
  const html = renderToStaticMarkup(<DriveHeader
    offsetForSidebarToggle
    tabs={[
      { key: 'repo', label: 'Repo', href: '/projects/p1/files', active: true },
      { key: 'review', label: 'Review', href: '/projects/p1/files/review', active: false },
    ]}
    historyToggle={{ open: true, onToggle() {} }}
    reviewsToggle={{ open: false, onToggle() {}, openCount: 2 }}
    onRefresh={() => {}} onDownloadDir={() => {}}
  />);
  expect(html.match(/kx-capability-titlebar/g)).toHaveLength(1);
  expect(html).toContain('href="/projects/p1/files/review"');
  expect(html).toContain('href="/projects/p1/files"');
  expect(html).toContain('main version');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('Explorer menu');
  expect(html).toContain('src folder');
});
