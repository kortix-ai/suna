import { describe, expect, test } from 'bun:test';

import type { KortixProject } from '@kortix/sdk';

import { hubTarget } from '../stores/account-panel-store';
import { pickWorkspaceForAccount, routeProjectIdOf, workspaceSettingsHref } from './workspace-settings-route';

function project(id: string, accountId: string, overrides: Partial<KortixProject> = {}): KortixProject {
  return { project_id: id, account_id: accountId, name: id, status: 'active', last_opened_at: null, ...overrides } as KortixProject;
}

describe('workspaceSettingsHref — an old hub link opens a workspace section', () => {
  test('members lands on People › Members', () => {
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'members' }))).toBe('/workspaces/p1/admin/members');
  });

  test('every renamed tab lands on its workspace section, drill-downs kept', () => {
    // The account Settings pane is Security now; Access merged into Members.
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'settings' }))).toBe('/workspaces/p1/admin/security');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'tokens' }))).toBe('/workspaces/p1/admin/api-keys');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'billing' }))).toBe('/workspaces/p1/admin/plan');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'usage' }))).toBe('/workspaces/p1/admin/usage');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'access-projects', project: 'p1' }))).toBe(
      '/workspaces/p1/admin/members?accountProject=p1',
    );
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'members', member: 'u9' }))).toBe(
      '/workspaces/p1/admin/members?accountMember=u9',
    );
  });

  test('an old tab that names a workspace section opens it (capture, a Library section)', () => {
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'capture' }))).toBe('/workspaces/p1/admin/capture');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'connectors' }))).toBe('/workspaces/p1/admin/connectors');
  });

  test('no tab, or a tab that no longer exists, opens the settings root', () => {
    expect(workspaceSettingsHref('p1', hubTarget('a1'))).toBe('/workspaces/p1/admin');
    expect(workspaceSettingsHref('p1', hubTarget('a1', { tab: 'gone' }))).toBe('/workspaces/p1/admin');
  });
});

describe('pickWorkspaceForAccount — which workspace an account link means', () => {
  const projects = [
    project('old', 'a1', { last_opened_at: '2026-01-01T00:00:00Z' }),
    project('new', 'a1', { last_opened_at: '2026-06-01T00:00:00Z' }),
    project('gone', 'a1', { status: 'archived', last_opened_at: '2026-09-01T00:00:00Z' }),
  ];

  test('the workspace on screen, when it belongs to the account', () => {
    expect(pickWorkspaceForAccount({ accountId: 'a1', routeProjectId: 'old', routeProjectAccountId: 'a1', projects: undefined })).toBe('old');
    expect(pickWorkspaceForAccount({ accountId: 'a1', routeProjectId: 'old', routeProjectAccountId: null, projects })).toBe('old');
  });

  test('else the most recently opened active project of the account', () => {
    expect(pickWorkspaceForAccount({ accountId: 'a1', routeProjectId: 'elsewhere', routeProjectAccountId: 'a2', projects })).toBe('new');
  });

  test('no project, no account, or an unknown list: nothing to open', () => {
    expect(pickWorkspaceForAccount({ accountId: 'a1', routeProjectId: null, routeProjectAccountId: null, projects: [] })).toBeNull();
    expect(pickWorkspaceForAccount({ accountId: '', routeProjectId: 'old', routeProjectAccountId: '', projects })).toBeNull();
    expect(pickWorkspaceForAccount({ accountId: 'a1', routeProjectId: null, routeProjectAccountId: null, projects: undefined })).toBeNull();
  });
});

describe('routeProjectIdOf', () => {
  test('reads the workspace id of a project route, with or without a locale', () => {
    expect(routeProjectIdOf('/workspaces/p1/sessions/s1')).toBe('p1');
    expect(routeProjectIdOf('/de/workspaces/p1')).toBe('p1');
    expect(routeProjectIdOf('/workspaces/start')).toBeNull();
    expect(routeProjectIdOf('/settings')).toBeNull();
  });
});
