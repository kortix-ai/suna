import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { KortixAccount, KortixProject, MyAccountInvite } from '@kortix/sdk';

import { ProjectSelectorView, type InlineCreateProps, type ProjectSelectorViewProps } from './project-selector';
import { buildWorkspaceRows } from '@kortix/ui/workspace/project-selector/project-selector-model';

function account(id: string, role: KortixAccount['account_role'], name: string): KortixAccount {
  return { account_id: id, name, account_role: role } as KortixAccount;
}

function project(id: string, accountId: string, name: string): KortixProject {
  return { project_id: id, account_id: accountId, name, status: 'active', last_opened_at: null } as KortixProject;
}

const invite = {
  invite_id: 'inv-1',
  account_id: 'acc-x',
  account_name: 'Example Org',
  initial_role: 'admin',
  inviter_email: 'inviter@example.com',
  created_at: '2026-09-21T00:00:00.000Z',
  expires_at: '2026-10-05T00:00:00.000Z',
  projects: [{ project_id: 'p-x', name: 'Example Workspace', role: 'member' }],
} as MyAccountInvite;

function render(overrides: Partial<ProjectSelectorViewProps>): string {
  const props: ProjectSelectorViewProps = {
    email: 'user@example.com',
    loading: false,
    loadFailed: false,
    workspaces: [],
    invites: [],
    createHref: '/workspaces/new',
    joiningInviteId: null,
    openingProjectId: null,
    signingOut: false,
    onJoin: () => {},
    onOpenProject: () => {},
    onRetryAll: () => {},
    onLogOut: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ProjectSelectorView, props));
}

function inlineCreate(overrides: Partial<InlineCreateProps> = {}): InlineCreateProps {
  return {
    name: 'Amber Falcon',
    nameError: null,
    canSubmit: true,
    submitting: false,
    phase: null,
    error: null,
    canRetry: false,
    onNameChange: () => {},
    onNameBlur: () => {},
    onSubmit: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

const twoAccounts = buildWorkspaceRows({
  accounts: [account('a', 'owner', 'Acme'), account('b', 'member', 'Globex')],
  lists: [
    { accountId: 'a', data: [project('p1', 'a', 'Website'), project('p2', 'a', 'Billing')], isError: false },
    { accountId: 'b', data: [project('p3', 'b', 'Support')], isError: false },
  ],
});

describe('ProjectSelectorView — create or join', () => {
  test('0 workspaces, 0 invites: "Create a workspace", one primary create button, the invite hint', () => {
    const html = render({});
    expect(html).toContain('Create a workspace');
    expect(html).toContain('A workspace is where your company works with Kortix');
    expect(html).toContain('data-testid="selector-create"');
    expect(html).toContain('href="/workspaces/new"');
    expect(html).toContain('Invited? Open the invite link from your email, or ask an admin to invite user@example.com.');
    expect(html).not.toContain('data-testid="selector-project"');
  });

  test('0 workspaces with the inline form: the name field, a submit button, More options to /workspaces/new', () => {
    const html = render({ inlineCreate: inlineCreate() });
    expect(html).toContain('Create a workspace');
    expect(html).toContain('data-testid="selector-create-form"');
    expect(html).toContain('value="Amber Falcon"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-testid="selector-create"/);
    expect(html).toContain('href="/workspaces/new"');
    expect(html).toContain('data-testid="selector-create-more"');
    expect(html).toContain('Invited? Open the invite link from your email');
  });

  test('a create in flight replaces the page with the handoff', () => {
    const html = render({ inlineCreate: inlineCreate({ submitting: true }) });
    expect(html).not.toContain('data-testid="selector-create-form"');
    expect(html).toContain('Amber Falcon');
  });

  // Finding 38: the create primes the list with the new workspace before the
  // route changes; the handoff must stay up, not flash the chooser.
  test('a create in flight keeps the handoff even after the new workspace joined the list', () => {
    const html = render({ workspaces: twoAccounts, inlineCreate: inlineCreate({ submitting: true }) });
    expect(html).not.toContain('Choose a workspace');
    expect(html).not.toContain('data-testid="selector-workspaces"');
  });

  test('a deleting row offers Restore and a setup_required row offers Set up; neither is a link', () => {
    const [first, second] = twoAccounts;
    const html = render({
      workspaces: [
        { ...first!, state: 'deleting', deletionScheduledFor: '2026-11-20T00:00:00.000Z' },
        { ...second!, state: 'setup_required' },
      ],
    });
    expect(html).toContain('data-state="deleting"');
    expect(html).toContain('Restore');
    expect(html).toContain('data-state="setup_required"');
    expect(html).toContain('Set up');
    expect(html).not.toContain(`href="/workspaces/${first!.workspaceId}"`);
  });

  test('with workspaces the inline form is not shown: one create link', () => {
    const html = render({ workspaces: twoAccounts, inlineCreate: inlineCreate() });
    expect(html).not.toContain('data-testid="selector-create-form"');
    expect(html).toContain('href="/workspaces/new"');
  });

  test('an owned empty account is not a workspace: the user still sees the create screen', () => {
    const workspaces = buildWorkspaceRows({
      accounts: [account('a', 'owner', 'Me')],
      lists: [{ accountId: 'a', data: [], isError: false }],
    });
    const html = render({ workspaces });
    expect(html).toContain('Create a workspace');
    expect(html).not.toContain('Me');
  });

  test('invites render first with Join, the inviter and the role, then the create action', () => {
    const html = render({ invites: [invite] });
    expect(html).toContain('You&#x27;re invited');
    expect(html).toContain('Example Workspace');
    expect(html).toContain('Invited by inviter@example.com');
    expect(html).toContain('Admin');
    expect(html).toContain('Sent to user@example.com');
    expect(html.indexOf('selector-invites')).toBeLessThan(html.indexOf('selector-create'));
    expect(html).not.toContain('Invited? Open the invite link');
  });

  test('1+ workspaces: one flat list, no account heading, role on each row, one create action', () => {
    const html = render({ workspaces: twoAccounts });
    expect(html).toContain('Choose a workspace');
    expect(html.split('data-testid="selector-project"').length - 1).toBe(3);
    expect(html).toContain('href="/workspaces/p1"');
    expect(html).toContain('href="/workspaces/p3"');
    expect(html).not.toContain('Acme');
    expect(html).not.toContain('Globex');
    expect(html).toContain('Owner');
    expect(html).toContain('Member');
    expect(html.split('data-testid="selector-create"').length - 1).toBe(1);
    expect(html).not.toContain('ask an admin');
  });

  test('search appears only above 8 workspaces', () => {
    expect(render({ workspaces: twoAccounts })).not.toContain('Find a workspace');
    const many = buildWorkspaceRows({
      accounts: [account('a', 'owner', 'Acme')],
      lists: [{ accountId: 'a', data: Array.from({ length: 9 }, (_, i) => project(`p${i}`, 'a', `P${i}`)), isError: false }],
    });
    expect(render({ workspaces: many })).toContain('Find a workspace');
  });

  test('restricted self-host with no invite: no create action, ask an admin to invite the email', () => {
    const html = render({ createHref: null });
    expect(html).toContain('No workspace yet');
    expect(html).toContain('Ask an admin to invite user@example.com.');
    expect(html).not.toContain('data-testid="selector-create"');
  });

  test('a failed list offers Try again; a total failure replaces the list', () => {
    expect(render({ workspaces: twoAccounts, partialFailure: true })).toContain('Could not load every workspace.');
    const total = render({ loadFailed: true });
    expect(total).toContain('Could not load your workspaces');
    expect(total).not.toContain('data-testid="selector-create"');
  });

  test('the account menu (which holds Log out) is always present', () => {
    expect(render({})).toContain('Logged in as');
    expect(render({ loading: true })).toContain('Logged in as');
    expect(render({ name: 'Dogfood Tester' })).toContain('>Dogfood Tester</span>');
    expect(render({ name: '  ' })).toContain('>user@example.com</span>');
  });

  test('computer pairing keeps its destination on every row and on create', () => {
    const html = render({ connectComputer: true, workspaces: twoAccounts });
    expect(html).toContain('href="/workspaces/p1/settings/computer"');
    expect(html).not.toContain('href="/workspaces/p1"');
    expect(html).toContain('href="/workspaces/new?connect=computer"');
  });
});
