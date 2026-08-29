import { describe, expect, test } from 'bun:test';

import {
  buildCreateRepoPayload,
  buildLinkRepositoryPayload,
  githubSourceReady,
  isGitHubSource,
  plannedRepoPath,
  repoSlugFromName,
  withRepositorySource,
} from './github-source';
import { INITIAL_FORM_STATE, type NewWorkspaceFormState } from './new-workspace-form';

const base: NewWorkspaceFormState = { ...INITIAL_FORM_STATE, name: 'Support desk' };

describe('repoSlugFromName', () => {
  test('replaces every character GitHub rejects, not just spaces', () => {
    // `POST /projects/create-repo` validates against /^[a-zA-Z0-9._-]+$/. The
    // old create modal only did `.replace(/\s+/g, '-')`, so an apostrophe
    // reached the route and came back 400.
    expect(repoSlugFromName("Ana's agents")).toBe('Ana-s-agents');
    expect(repoSlugFromName('support desk')).toBe('support-desk');
    expect(repoSlugFromName('a/b:c')).toBe('a-b-c');
  });

  test('collapses runs and trims edge punctuation', () => {
    expect(repoSlugFromName('a   b')).toBe('a-b');
    expect(repoSlugFromName('  -weird-  ')).toBe('weird');
    expect(repoSlugFromName('.dotfile.')).toBe('dotfile');
  });

  test('keeps characters GitHub accepts', () => {
    expect(repoSlugFromName('kortix.api_v2-beta')).toBe('kortix.api_v2-beta');
  });

  test('falls back rather than emitting an empty name the route would 400', () => {
    expect(repoSlugFromName('   ')).toBe('workspace');
    expect(repoSlugFromName('!!!')).toBe('workspace');
  });
});

describe('plannedRepoPath', () => {
  test('shows the derived repo before the create, so the slug is not a surprise', () => {
    expect(plannedRepoPath('acme', "Ana's agents")).toBe('github.com/acme/Ana-s-agents');
  });

  test('is null until an owner is known', () => {
    expect(plannedRepoPath(null, 'anything')).toBeNull();
  });
});

describe('isGitHubSource', () => {
  test('covers exactly the two sources that need an installation', () => {
    expect(isGitHubSource('managed')).toBe(false);
    expect(isGitHubSource('github-create')).toBe(true);
    expect(isGitHubSource('github-import')).toBe(true);
  });
});

describe('githubSourceReady', () => {
  test('managed needs nothing', () => {
    expect(githubSourceReady({ ...base, source: 'managed' })).toBe(true);
  });

  test('github-create needs an installation and nothing more', () => {
    expect(githubSourceReady({ ...base, source: 'github-create' })).toBe(false);
    expect(githubSourceReady({ ...base, source: 'github-create', installationId: '84' })).toBe(
      true,
    );
  });

  test('github-import needs an installation AND a repository', () => {
    expect(githubSourceReady({ ...base, source: 'github-import', installationId: '84' })).toBe(
      false,
    );
    expect(
      githubSourceReady({
        ...base,
        source: 'github-import',
        installationId: '84',
        repoFullName: 'acme/portal',
      }),
    ).toBe(true);
  });
});

describe('withRepositorySource', () => {
  test('clears the GitHub fields so an imported repo cannot leak into a create', () => {
    const imported: NewWorkspaceFormState = {
      ...base,
      source: 'github-import',
      installationId: '84',
      repoFullName: 'acme/portal',
    };
    const next = withRepositorySource(imported, 'github-create');
    expect(next.installationId).toBeNull();
    expect(next.repoFullName).toBeNull();
  });

  test('restores the managed branch default when leaving github-import', () => {
    // Otherwise a managed provision inherits the imported repository's trunk
    // name — a default branch the user never chose for a repo that does not
    // exist yet.
    const imported: NewWorkspaceFormState = {
      ...base,
      source: 'github-import',
      defaultBranch: 'trunk',
      installationId: '84',
      repoFullName: 'acme/portal',
    };
    expect(withRepositorySource(imported, 'managed').defaultBranch).toBe('main');
  });

  test('leaves a branch the user typed for managed alone', () => {
    const managed: NewWorkspaceFormState = { ...base, defaultBranch: 'develop' };
    expect(withRepositorySource(managed, 'github-import').defaultBranch).toBe('develop');
  });

  test('keeps the name, icon and template — only the source-owned fields reset', () => {
    const withIcon: NewWorkspaceFormState = {
      ...base,
      icon: { emoji: '🚀' },
      templateId: 'kortix-projects:support-agent-kit',
    };
    const next = withRepositorySource(withIcon, 'github-create');
    expect(next.name).toBe('Support desk');
    expect(next.icon).toEqual({ emoji: '🚀' });
    expect(next.templateId).toBe('kortix-projects:support-agent-kit');
  });
});

describe('buildCreateRepoPayload', () => {
  test('sends the slug as the repo name and the typed name as the workspace name', () => {
    const payload = buildCreateRepoPayload(
      { ...base, name: "Ana's agents", source: 'github-create', installationId: '84' },
      'acc-1',
    );
    expect(payload).toMatchObject({
      account_id: 'acc-1',
      name: 'Ana-s-agents',
      project_name: "Ana's agents",
      installation_id: '84',
      private: true,
      starter_template: 'general-knowledge-worker',
    });
  });

  test('never sends default_branch — the route does not accept one', () => {
    const payload = buildCreateRepoPayload(
      { ...base, source: 'github-create', installationId: '84', defaultBranch: 'trunk' },
      'acc-1',
    );
    expect(payload).not.toHaveProperty('default_branch');
  });

  test('forwards the clone template and the icon, each under its own key', () => {
    const emoji = buildCreateRepoPayload(
      { ...base, icon: { emoji: '🚀' }, templateId: 'item-1', installationId: '84' },
      'acc-1',
    );
    expect(emoji).toMatchObject({ icon: '🚀', source_item_id: 'item-1' });
    expect(emoji).not.toHaveProperty('icon_glyph');

    const glyph = buildCreateRepoPayload(
      { ...base, icon: { glyph: { name: 'Rocket', color: 'blue' } }, installationId: '84' },
      'acc-1',
    );
    expect(glyph).toMatchObject({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(glyph).not.toHaveProperty('icon');
  });

  test('omits keys rather than sending nulls the server would have to interpret', () => {
    const payload = buildCreateRepoPayload({ ...base, source: 'github-create' }, undefined);
    expect(payload).not.toHaveProperty('account_id');
    expect(payload).not.toHaveProperty('installation_id');
    expect(payload).not.toHaveProperty('icon');
  });
});

describe('buildLinkRepositoryPayload', () => {
  test('sends the repository, the installation, and the branch chosen for it', () => {
    const payload = buildLinkRepositoryPayload(
      {
        ...base,
        source: 'github-import',
        installationId: '84',
        repoFullName: 'acme/portal',
        defaultBranch: 'trunk',
      },
      'acc-1',
    );
    expect(payload).toMatchObject({
      account_id: 'acc-1',
      installation_id: '84',
      repo_full_name: 'acme/portal',
      name: 'Support desk',
      default_branch: 'trunk',
    });
  });

  test('omits an empty branch so the repository default wins server-side', () => {
    // `resolveImportedDefaultBranch` uses `repo.default_branch` when the key is
    // absent and VALIDATES it when present — sending '' would be a 400.
    const payload = buildLinkRepositoryPayload(
      {
        ...base,
        source: 'github-import',
        installationId: '84',
        repoFullName: 'acme/portal',
        defaultBranch: '   ',
      },
      'acc-1',
    );
    expect(payload).not.toHaveProperty('default_branch');
  });

  test('omits an empty name so the server derives one from the repo', () => {
    const payload = buildLinkRepositoryPayload(
      {
        ...base,
        name: '   ',
        source: 'github-import',
        installationId: '84',
        repoFullName: 'acme/portal',
      },
      'acc-1',
    );
    expect(payload).not.toHaveProperty('name');
  });
});
