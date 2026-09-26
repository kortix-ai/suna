import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { KortixAccount, KortixProject, MyAccountInvite } from '@kortix/sdk';

import { ProjectSelectorView, type ProjectSelectorViewProps } from './project-selector';
import { buildAccountSections } from './project-selector-model';

function account(id: string, role: KortixAccount['account_role'], name: string): KortixAccount {
  return { account_id: id, name, account_role: role } as KortixAccount;
}

function project(id: string, accountId: string, name: string): KortixProject {
  return { project_id: id, account_id: accountId, name, status: 'active', last_opened_at: null } as KortixProject;
}

const invite = {
  invite_id: 'inv-1',
  account_id: 'acc-x',
  account_name: 'Mirkos Org',
  initial_role: 'member',
  inviter_email: 'marko@kortix.ai',
  created_at: '2026-09-21T00:00:00.000Z',
  expires_at: '2026-10-05T00:00:00.000Z',
  projects: [{ project_id: 'p-x', name: 'Mirko Boss 900', role: 'member' }],
} as MyAccountInvite;

function render(overrides: Partial<ProjectSelectorViewProps>): string {
  const props: ProjectSelectorViewProps = {
    email: 'user@example.com',
    loading: false,
    loadFailed: false,
    sections: [],
    invites: [],
    createHref: '/new?account=a',
    joiningInviteId: null,
    openingProjectId: null,
    signingOut: false,
    onJoin: () => {},
    onOpenProject: () => {},
    onRetryAccount: () => {},
    onRetryAll: () => {},
    onLogOut: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ProjectSelectorView, props));
}

describe('ProjectSelectorView', () => {
  test('new user: welcome, one create card, no project form fields', () => {
    const html = render({
      sections: buildAccountSections({ accounts: [account('a', 'owner', 'Me')], lists: [{ accountId: 'a', data: [], isError: false }] }),
    });
    expect(html).toContain('Welcome to Kortix');
    expect(html).toContain('data-testid="selector-create"');
    expect(html).toContain('href="/new?account=a"');
    expect(html).not.toContain('Project name');
    expect(html).not.toContain('or open an existing project');
    // The empty account the card targets is not listed a second time.
    expect(html).not.toContain('No projects in this workspace yet.');
  });

  test('a second empty account the card does not target keeps its own create row', () => {
    const html = render({
      sections: buildAccountSections({
        accounts: [account('a', 'owner', 'Me'), account('b', 'owner', 'Team')],
        lists: [
          { accountId: 'a', data: [], isError: false },
          { accountId: 'b', data: [], isError: false },
        ],
      }),
    });
    expect(html).toContain('href="/new?account=b"');
    expect(html).toContain('No projects in this workspace yet.');
  });

  test('returning user: every project is a link to its page, grouped under the account', () => {
    const html = render({
      sections: buildAccountSections({
        accounts: [account('a', 'owner', 'Acme')],
        lists: [{ accountId: 'a', data: [project('p1', 'a', 'Website'), project('p2', 'a', 'Billing')], isError: false }],
      }),
    });
    expect(html).toContain('Welcome back');
    expect(html).toContain('Acme');
    expect(html).toContain('Owner · 2 projects');
    expect(html).toContain('href="/projects/p1"');
    expect(html).toContain('href="/projects/p2"');
    expect(html).toContain('or open an existing project');
  });

  test('invites render first with Join and the recipient email', () => {
    const html = render({ invites: [invite] });
    expect(html).toContain('data-testid="selector-invites"');
    expect(html).toContain('Mirko Boss 900');
    expect(html).toContain('Invited by marko@kortix.ai');
    expect(html).toContain('Sent to user@example.com');
    expect(html.indexOf('selector-invites')).toBeLessThan(html.indexOf('selector-account') === -1 ? Infinity : html.indexOf('selector-account'));
  });

  test('account member without access: the account shows an ask-an-admin line, no create card', () => {
    const html = render({
      createHref: null,
      sections: buildAccountSections({ accounts: [account('m', 'member', 'Acme')], lists: [{ accountId: 'm', data: [], isError: false }] }),
    });
    expect(html).toContain('data-testid="selector-empty-member"');
    expect(html).toContain('Ask an owner or admin for access');
    expect(html).not.toContain('data-testid="selector-create"');
  });

  test('no account, no invite, no create right: the no-access message names the email', () => {
    const html = render({ createHref: null, sections: [] });
    expect(html).toContain('No projects yet');
    expect(html).toContain('Ask an owner or admin to invite user@example.com.');
  });

  test('more than five projects collapse behind "Show all N"', () => {
    const projects = Array.from({ length: 7 }, (_, i) => project(`p${i}`, 'a', `P${i}`));
    const html = render({
      sections: buildAccountSections({ accounts: [account('a', 'owner', 'Acme')], lists: [{ accountId: 'a', data: projects, isError: false }] }),
    });
    expect(html.split('data-testid="selector-project"').length - 1).toBe(5);
    expect(html).toContain('Show all 7');
  });

  test('a failed account offers Retry; a total failure replaces the list', () => {
    const partial = render({
      sections: buildAccountSections({ accounts: [account('a', 'owner', 'Acme')], lists: [{ accountId: 'a', data: undefined, isError: true }] }),
    });
    expect(partial).toContain('Could not load these projects.');
    const total = render({ loadFailed: true });
    expect(total).toContain('Could not load your projects');
    expect(total).not.toContain('data-testid="selector-create"');
  });

  test('Log out is always present', () => {
    expect(render({})).toContain('Log out');
    expect(render({ loading: true })).toContain('Log out');
  });
});
