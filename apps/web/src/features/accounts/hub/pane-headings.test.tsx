import { AccessProjectsTab } from '@/components/iam/access-projects-tab';
import { GroupsTab } from '@/components/iam/groups-tab';
import { testUiTranslator } from '@/i18n/test-translator';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPane } from './account-pane';
import { localizedAccountPaneMeta } from '@kortix/ui/internal/account-hub/sections';

const noop = () => {};

describe('account pane heading navigation', () => {
  test('Git uses the same level-one pane title as its siblings', () => {
    const meta = localizedAccountPaneMeta(testUiTranslator).git;
    const html = renderToStaticMarkup(<AccountPane title={meta?.title} />);
    expect(html).toMatch(/<h1\b[^>]*>Git<\/h1>/);
  });

  for (const loading of [true, false]) {
    test(`Groups and Projects retain level-one titles with loading=${loading}`, () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      if (!loading) {
        client.setQueryData(['account-groups', 'synthetic-account'], []);
        client.setQueryData(qk.projects.list('synthetic-account'), []);
      }
      const groups = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <GroupsTab
            accountId="synthetic-account"
            canCreate={false}
            rbacEnabled={false}
            canReadRoles={false}
            canReadPolicies={false}
            currentUserId="synthetic-user"
            canUpdateRole={false}
            canReadMembers={false}
            onSelectMember={noop}
            selectedGroupId={null}
            onSelectGroup={noop}
          />
        </QueryClientProvider>,
      );
      expect(groups).toMatch(/<h1\b[^>]*>Groups<\/h1>/);
      const projects = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <AccessProjectsTab
            accountId="synthetic-account"
            selectedProjectId={null}
            onSelectProject={noop}
            rbacEnabled={false}
            canManageRoles={false}
          />
        </QueryClientProvider>,
      );
      expect(projects).toMatch(/<h1\b[^>]*>Projects<\/h1>/);
      client.clear();
    });
  }
});
