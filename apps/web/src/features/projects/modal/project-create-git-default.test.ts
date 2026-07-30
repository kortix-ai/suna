import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-create-modal.tsx'), 'utf8');

describe('new project git provider default', () => {
  test('starts with a managed repository and keeps user GitHub explicit', () => {
    expect(source).toContain("'github-create' | 'github-import' | 'managed' | 'template'");
    expect(source).toMatch(/useState<[\s\S]*?>\(\s*'managed'/);
    expect(source).toContain('createProjectRepo');
    expect(source).toContain('Create in your GitHub');
    expect(source).not.toContain('Code Storage');
    expect(source).not.toMatch(/<GitFork className="size-4" \/> Managed by Kortix/);
  });

  test('keeps a selected marketplace template on the managed path', () => {
    expect(source).toMatch(/function pickTemplate[\s\S]*?setMode\('managed'\)/);
  });

  test('uses current project-modal list and radius primitives', () => {
    expect(source).not.toContain('@/components/ui/list');
    expect(source).not.toContain('rounded-2xl');
  });

  test('uses one generic starter without a starter selector', () => {
    expect(source).not.toContain('StarterTemplateId');
    expect(source).not.toContain('ACP multi-harness');
    expect(source).not.toContain('data-testid="project-create-starter"');
    expect(source).toContain("starter_template: 'general-knowledge-worker'");
  });

  test('does not mistake the managed PAT import fallback for a GitHub App installation', () => {
    expect(source).toContain('isGitHubAppInstallationId');
    expect(source).toContain('githubAppInstallations');
    expect(source).toContain('installation_id: selectedInstallationId');
  });

  test('searches large GitHub owners remotely and exposes repository load failures', () => {
    expect(source).toContain('useDebounce(repositorySearch.trim(), 300)');
    expect(source).toContain("search: debouncedRepositorySearch || undefined");
    expect(source).toContain('onSearchChange={setRepositorySearch}');
    expect(source).toContain('githubReposQuery.isError');
    expect(source).toContain('Could not load repositories');
    expect(source).toContain('githubReposQuery.refetch()');
  });

  test('explains how to link an existing GitHub App installation', () => {
    expect(source).toContain('Link a GitHub account');
    expect(source).toContain(
      'Select Configure in GitHub when the Kortix App is already installed.',
    );
    expect(source).toContain("isConnectingGitHub ? 'Connecting' : 'Link GitHub'");
  });
});

describe('new project dialog: simplified default state', () => {
  test('repository source starts collapsed behind a disclosure, not shown up front', () => {
    // The 3-way tabs live inside DisclosureContent, gated by `advancedOpen`
    // (default false) — never rendered open on mount.
    expect(source).toMatch(/const \[advancedOpen, setAdvancedOpen\] = useState\(false\)/);
    expect(source).toContain('<DisclosureTrigger>');
    expect(source).toContain('<DisclosureContent>');
    expect(source).toContain("'Hide repository options' : 'Use my own GitHub'");
    // The tabs render inside DisclosureContent, not as a direct sibling of
    // the trigger row — so they stay collapsed until the trigger is opened.
    expect(source).toMatch(
      /<DisclosureContent>[\s\S]*?<Label>Repository source<\/Label>[\s\S]*?<\/DisclosureContent>/,
    );
  });

  test('reopens the repository picker automatically once the user leaves the managed default', () => {
    expect(source).toContain(
      "const repositoryOptionsOpen = advancedOpen || mode !== 'managed' || managedGitUnavailable;",
    );
  });

  test('resets the disclosure back to collapsed when the modal closes', () => {
    expect(source).toMatch(/function resetAndClose\(\)[\s\S]*?setAdvancedOpen\(false\)/);
  });

  test('removes the duplicated "Managed repository" and "Starter skills" cards', () => {
    expect(source).not.toContain('Managed repository');
    expect(source).not.toContain('Starter skills');
    expect(source).not.toContain('Starter pack');
    expect(source).not.toContain('Kortix creates a private repository and manages its credentials.');
  });

  test('the account switcher only renders when there is more than one account to choose from', () => {
    expect(source).toMatch(
      /accountSelection\.canSwitch && accountSelection\.currentAccount \? \(\s*<CreateAccountField/,
    );
  });

  test('repository options render below the project name field, not above it', () => {
    // `autoFocus` only lives on the managed-form name Input — the primary
    // 95%-path field. Its own RepositoryOptions usage (the nearest one
    // after it) must come after it in source order, i.e. below it in that
    // form body, not above as a header-level block.
    expect(source).toMatch(/autoFocus[\s\S]*?<RepositoryOptions/);

    // The github-import form's name field has no autoFocus (it's the last
    // field in that body) — anchor on its placeholder key instead and
    // confirm its own RepositoryOptions usage also comes after it.
    expect(source).toMatch(
      /line516JsxAttrPlaceholderUseRepositoryName[\s\S]*?<RepositoryOptions/,
    );

    // Managed/github-create body, github-import body, and the
    // managed-git-unavailable fallback (a documented exception — it has no
    // name field to anchor below) each render it exactly once.
    const usages = source.match(/<RepositoryOptions/g) ?? [];
    expect(usages).toHaveLength(3);
  });

  test('extracts one RepositoryOptions component instead of duplicating the tabs block per mode', () => {
    const definitionMatches = source.match(/function RepositoryOptions\(/g) ?? [];
    expect(definitionMatches).toHaveLength(1);
  });

  test('never shows a collapse trigger the user cannot act on', () => {
    // `collapsible` is only true for the silent default (managed mode, git
    // usable) — everywhere `repositoryOptionsOpen` is forced true, the
    // component must fall back to a plain label instead of a "Hide" button
    // that does nothing.
    expect(source).toContain(
      "const repositoryOptionsCollapsible = mode === 'managed' && !managedGitUnavailable;",
    );
    expect(source).toMatch(
      /\{collapsible \? \(\s*<div className="flex flex-wrap items-center gap-1">\s*<DisclosureTrigger>/,
    );
    expect(source).toContain('<Label className="text-muted-foreground">Repository source</Label>');
  });

  test('the managed-git-unavailable state does not show two ways to import an existing repo at once', () => {
    expect(source).toMatch(
      /secondaryAction=\{\s*cloningFromSource \? \(\s*<Button[\s\S]*?Import an existing repo[\s\S]*?\) : undefined\s*\}/,
    );
  });
});
