import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolve } from 'node:path';
import { readFileSync } from '@/i18n/test-source';

import type { MyAccountInvite } from '@kortix/sdk';

import {
  chooserMode,
  joinDestination,
  ProjectChooserView,
  type ProjectChooserViewProps,
} from './project-chooser';

function invite(overrides: Partial<MyAccountInvite> = {}): MyAccountInvite {
  return {
    invite_id: 'inv-1',
    account_id: 'acc-1',
    account_name: 'Mirkos Org',
    initial_role: 'member',
    inviter_email: 'marko@kortix.ai',
    created_at: '2026-09-21T00:00:00.000Z',
    expires_at: '2026-10-05T00:00:00.000Z',
    projects: [{ project_id: 'p-1', name: 'Mirko Boss 900', role: 'member' }],
    ...overrides,
  };
}

describe('chooserMode', () => {
  test('any pending invite puts the invites first, whatever the create permission', () => {
    expect(chooserMode({ inviteCount: 1, canCreate: true })).toBe('invites');
    expect(chooserMode({ inviteCount: 2, canCreate: false })).toBe('invites');
  });

  test('no invites and create permission is the empty state with one create action', () => {
    expect(chooserMode({ inviteCount: 0, canCreate: true })).toBe('empty');
  });

  test('no invites and no create permission tells the user to ask for an invite', () => {
    expect(chooserMode({ inviteCount: 0, canCreate: false })).toBe('no-permission');
  });
});

describe('joinDestination', () => {
  test('a project invite opens the first invited project', () => {
    const inv = invite({
      projects: [
        { project_id: 'p-1', name: 'Mirko Boss 900', role: 'member' },
        { project_id: 'p-2', name: 'Other', role: 'member' },
      ],
    });
    expect(joinDestination(inv)).toBe('/projects/p-1');
  });

  test('a plain workspace invite has no project to open, so the door resolves one', () => {
    expect(joinDestination(invite({ projects: [] }))).toBeNull();
  });
});

function render(props: Partial<ProjectChooserViewProps>) {
  return renderToStaticMarkup(
    createElement(ProjectChooserView, {
      email: 'test21221x@yopmail.com',
      invites: [],
      invitesLoading: false,
      canCreate: true,
      joiningInviteId: null,
      onJoin: () => {},
      onLogOut: () => {},
      signingOut: false,
      ...props,
    }),
  );
}

describe('ProjectChooserView', () => {
  // Same page shape as `/new`: one heading, the muted line, the quiet Log out.
  test('invites: heading, the invite row with workspace and inviter, Join, and a quiet create link', () => {
    const html = render({ invites: [invite()] });
    expect(html).toContain("You&#x27;re invited");
    expect(html).toContain('Invitations');
    expect(html).toContain('Mirko Boss 900');
    expect(html).toContain('Mirkos Org');
    expect(html).toContain('Invited by marko@kortix.ai');
    expect(html).toContain('Join');
    expect(html).toContain('Create a new project instead');
    expect(html).toContain('Log out');
  });

  test('the empty state is the /new create form itself, with no Back link to this page', () => {
    const source = readFileSync(resolve(import.meta.dir, 'project-chooser.tsx'), 'utf8');
    expect(source).toContain('<NewWorkspacePage showBack={false} />');
  });

  test('while invites load, the page is blank: no spinner', () => {
    const html = render({ invitesLoading: true });
    expect(html).not.toContain('Join');
    expect(html).not.toContain('<svg');
    expect(html).toContain('Log out');
  });

  test('a member with no invites and no create permission gets no create control', () => {
    const html = render({ canCreate: false });
    expect(html).toContain('No workspace yet');
    expect(html).not.toContain('href="/new"');
    expect(html).toContain('Log out');
  });

  test('an invitee without create permission gets Join but no create link', () => {
    const html = render({ invites: [invite()], canCreate: false });
    expect(html).toContain('Join');
    expect(html).not.toContain('href="/new"');
  });

  test('a join in flight disables every Join button', () => {
    const html = render({
      invites: [invite(), invite({ invite_id: 'inv-2', account_name: 'Second Org' })],
      joiningInviteId: 'inv-1',
    });
    expect(html.match(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Join/g)?.length).toBe(2);
  });

  test('the chooser never links back to /projects, which redirects here', () => {
    for (const props of [{}, { canCreate: false }, { invites: [invite()] }]) {
      expect(render(props)).not.toContain('href="/projects"');
    }
  });
});
