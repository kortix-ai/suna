/**
 * Account X → Projects must offer "New project", and the project it creates
 * must belong to account X.
 *
 * The pane listed an account's projects with no way to add one, so a person
 * could not target a chosen account when creating a project at all — `/new`
 * defaults to their PERSONAL account (`resolveDefaultCreatableAccountId`).
 *
 * Pinned:
 * - the button is gated on `project.create`, the leaf `POST /projects/provision`
 *   asserts — probed in the hub's ONE batched request, not a role name;
 * - it renders in the pane header, and in the empty state of an account with no
 *   projects (never for an empty search);
 * - it goes to `/new?account=<THIS account>`, which seeds the form's account.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../../../translations/en.json';

const read = (relative: string) => readFileSync(join(import.meta.dir, relative), 'utf8');

const tab = read('../../../components/iam/access-projects-tab.tsx');
const content = read('account-hub-content.tsx');
const access = read('use-account-hub-access.ts');

const picker = tab.slice(tab.indexOf('function ProjectPicker('), tab.indexOf('function ProjectListRow('));
const button = tab.slice(
  tab.indexOf('function NewProjectButton('),
  tab.indexOf('function ProjectPicker('),
);

describe('New project — gate', () => {
  test('the hub probes project.create and passes the verdict to the tab', () => {
    expect(access).toContain("{ action: 'project.create' },");
    expect(access).toContain('{ allowed: canCreateProject },');
    expect(content).toContain('canCreateProject={canCreateProject === true}');
  });

  test('the tab defaults to no button and forwards the flag to the picker', () => {
    expect(tab).toContain('canCreateProject = false,');
    expect(tab).toContain('canCreateProject={canCreateProject}');
  });
});

describe('New project — placement', () => {
  test('the picker header renders it when allowed', () => {
    const header = picker.indexOf("tI18nComplete.raw('text9949095feb15')");
    const headerButton = picker.indexOf(
      '{canCreateProject ? <NewProjectButton accountId={accountId} variant="secondary" /> : null}',
    );
    expect(headerButton).toBeGreaterThan(header);
    // Before the search field: it belongs to the pane header, not the list.
    expect(headerButton).toBeLessThan(picker.indexOf('<InputGroupSearch>'));
  });

  test('the empty state offers it only when there is no search', () => {
    expect(picker).toContain('!search && canCreateProject ? (');
    expect(picker).toContain('<NewProjectButton accountId={accountId} variant="outline" />');
  });
});

describe('New project — destination', () => {
  test('goes to /new scoped to THIS account, replacing the hub entry', () => {
    const forget = button.indexOf('forgetPushedEntry();');
    const replace = button.indexOf('router.replace(newWorkspacePathForAccount(accountId));');
    expect(forget).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(forget);
  });

  test('labelled with a real translation key', () => {
    expect(button).toContain("tI18nComplete.raw('texta41eb2bf7245')");
    expect(en.hardcodedUi.i18nComplete.texta41eb2bf7245).toBe('New project');
  });
});
