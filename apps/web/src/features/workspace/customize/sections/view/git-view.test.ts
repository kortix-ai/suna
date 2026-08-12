import type { ProjectGitConnection } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { projectRepoFallback, RepositoryValue } from './git-view';
import {
  connectionStatusLabel,
  providerLabel,
  providerSentence,
  repositoryWebUrl,
} from './git-view-helpers';

const source = readFileSync(join(import.meta.dir, 'git-view.tsx'), 'utf8');

/**
 * `source` with every comment removed.
 *
 * The absence assertions below ("no 'proxy origin' anywhere") must read the
 * code only. That file's header comment quotes the old strings verbatim to
 * explain what was replaced and why, so asserting against raw `source` fails on
 * the documentation rather than on a regression — and, worse, would pass the
 * day someone deletes the explanation. Strips block comments first, then
 * line comments, and deliberately leaves string literals alone: no user-facing
 * copy in this pane contains a `//` or a comment opener.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The shared control this pane's copyable lines delegate to.
 *
 * `git-view.tsx` used to hold its own `CopyValue`, animation and all. That
 * component is now `@/components/markdown/copy-button`, so the guarantee is
 * asserted where it lives — and paired with an assertion that this pane still
 * uses it, so moving the box out again cannot pass by relocating it twice.
 */
const copyControl = readFileSync(
  join(import.meta.dir, '../../../../../components/markdown/copy-button.tsx'),
  'utf8',
);

test('formats the live Code Storage provider identifier', () => {
  expect(providerLabel('code-storage')).toBe('Kortix Code Storage');
  expect(providerLabel('code_storage')).toBe('Kortix Code Storage');
});

test('only links repository providers with a human web page', () => {
  expect(repositoryWebUrl('github', 'https://github.com/acme/project.git')).toBe(
    'https://github.com/acme/project',
  );
  expect(repositoryWebUrl('code-storage', 'https://kortix.code.storage/project.git')).toBeNull();
});

test('states the provider as a sentence, and says Code Storage is stored not hosted', () => {
  expect(providerSentence('github')).toBe('Hosted on GitHub.');
  expect(providerSentence('gitlab')).toBe('Hosted on GitLab.');
  // Code Storage is Kortix's own storage, not a third-party host the user has
  // an account with — "Hosted on" would send them looking for a login.
  expect(providerSentence('code-storage')).toBe('Stored in Kortix Code Storage.');
});

test('never echoes a raw connection status enum at the user', () => {
  expect(connectionStatusLabel('connected')).toEqual({ tone: 'connected', label: 'Connected' });
  expect(connectionStatusLabel('error')).toEqual({ tone: 'attention', label: 'Needs attention' });
  expect(connectionStatusLabel('pending')).toEqual({ tone: 'unknown', label: 'Connecting…' });
  // The bug this pins: the pane used to render `connection?.status || 'Unknown'`,
  // so any status this UI had not been taught shipped itself to users verbatim.
  expect(connectionStatusLabel('some_new_backend_state')).toEqual({
    tone: 'unknown',
    label: 'Not connected',
  });
  expect(connectionStatusLabel(null)).toEqual({ tone: 'unknown', label: 'Not connected' });
});

test('copy control keeps both icons in an animated fixed-size box', () => {
  // The pane must reach the box through the shared control...
  expect(source).toContain("import { CopyButton } from '@/components/markdown/copy-button'");
  expect(source).toContain('<CopyButton code={value}');
  // ...and the box must still be a box: one fixed `size-5` cell both icons are
  // absolutely positioned inside, so swapping copy for check cannot reflow the
  // line, cross-faded rather than cut.
  expect(copyControl).toContain('relative inline-flex size-5');
  expect(copyControl).toContain('<AnimatePresence initial={false}');
  expect(copyControl).toContain("filter: 'blur(4px)'");
  // Closing braces included: `bounce: 0` is a prefix of `bounce: 0.4`, so the
  // bare needle passed on a bouncy spring — the one value this pins.
  expect(copyControl).toContain("transition={{ type: 'spring', duration: 0.3, bounce: 0 }}");
});

test('develop locally includes the environment-aware CLI installer before clone', () => {
  expect(source).toContain('useDeploymentCliInstallCommand(getEnv().VERSION)');
  expect(source).toContain('label="Install command"');
  expect(source.indexOf('label="Install command"')).toBeLessThan(
    source.indexOf('label="Clone command"'),
  );
});

test('the comment-stripped view of the source can still fail', () => {
  // Guard for the assertions below. A `.replace()` that over-matched would
  // leave `code` empty or near-empty, and every `not.toContain` after it would
  // pass forever while testing nothing. Prove the strip kept the code and
  // removed the prose in the same breath.
  expect(code).toContain('export function GitView');
  expect(code).toContain('<SettingsTabHeader tab="repositories" />');
  expect(code.length).toBeGreaterThan(source.length / 3);
  // The canary is the exact string the next test asserts is absent from the
  // code. `OwnGitClient`'s doc comment quotes the old section name verbatim to
  // say what it replaced, so it exists in `source` and must not survive into
  // `code` — which is the whole reason that assertion reads `code` at all.
  expect(source).toContain('Kortix proxy origin');
  expect(code).not.toContain('Kortix proxy origin');
});

test('renders exactly one page heading, from the shared rail entry', () => {
  // The duplication this rewrite removes: the pane used to stack a
  // `CustomizeSectionWrapper title="Git"` on `<h3>Repository` on
  // `<h3>Repository settings`, under a rail entry already reading
  // "Repositories". The title now has one source.
  expect(code).toContain('<SettingsTabHeader tab="repositories" />');
  expect(code).not.toContain('CustomizeSectionWrapper');
  expect(code).not.toContain('Repository settings');
});

test('does not name internal mechanisms in user-facing copy', () => {
  // "Kortix proxy origin" / "resolves the current provider credential just in
  // time" named the mechanism and never said when a person would use it.
  expect(code).not.toContain('proxy origin');
  expect(code).not.toContain('Proxy URL');
  expect(code).not.toContain('Connection health');
  expect(code).toContain('Use your own Git client');
});

test('every technical setting carries a docs link', () => {
  expect(code).toContain("const DOCS_CLI = '/docs/cli'");
  expect(code).toContain("const DOCS_MANIFEST = '/docs/project/manifest'");
  expect(code).toContain('<DocsLink href={DOCS_MANIFEST} />');
  expect(code).toContain('action={<DocsLink href={DOCS_CLI} />}');
});

/**
 * The Repository row's three states.
 *
 * The regression these pin: this pane read `connection?.repo_url` only, so a
 * project carrying its own `repo_url` with NO `project_git_connections` row
 * rendered "Not linked yet" and offered no way to reach a repository that was
 * sitting in the project record. `settings-view.tsx` on `main` linked straight
 * off `project.repo_url` and never consulted a connection at all.
 *
 * `RepositoryValue` is rendered directly with `createElement` — this file is a
 * `.ts`, so it has no JSX, and `apps/web` has no DOM harness. Static markup is
 * enough: every claim here is about what the row emits, not about behaviour.
 */
const connection: ProjectGitConnection = {
  connection_id: 'c1',
  account_id: 'a1',
  project_id: 'p1',
  provider: 'github',
  repo_url: 'https://github.com/acme/connected.git',
  repo_owner: 'acme',
  repo_name: 'connected',
  external_repo_id: null,
  default_branch: 'main',
  auth_method: 'app',
  installation_id: null,
  visibility: 'private',
  status: 'connected',
  last_validated_at: null,
  last_error_code: null,
  last_error_message: null,
  metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const renderRepositoryValue = (props: Parameters<typeof RepositoryValue>[0]) =>
  renderToStaticMarkup(createElement(RepositoryValue, props));

test('with a connection row, the connection is the source of truth', () => {
  // Both are set and they disagree. The connection wins — it is the only thing
  // that knows the owner/name split the backend resolved.
  const out = renderRepositoryValue({
    connection,
    repoUrl: 'https://github.com/acme/stale-project.git',
  });
  expect(out).toContain('href="https://github.com/acme/connected"');
  expect(out).toContain('acme/connected');
  expect(out).not.toContain('stale-project');
});

test('with no connection row, the project repo_url is still linked', () => {
  const out = renderRepositoryValue({
    connection: null,
    repoUrl: 'https://github.com/acme/project.git',
  });
  expect(out).toContain('href="https://github.com/acme/project"');
  expect(out).toContain('acme/project');
  // The exact state that used to render as a dead end.
  expect(out).not.toContain('Not linked yet');
});

test('the fallback link opens safely, matching main', () => {
  const out = renderRepositoryValue({
    connection: undefined,
    repoUrl: 'https://github.com/acme/project.git',
  });
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
});

test('with neither a connection nor an address, the row says so and links nothing', () => {
  const out = renderRepositoryValue({ connection: null, repoUrl: '' });
  expect(out).toContain('Not linked yet');
  expect(out).not.toContain('<a ');
});

test('an address on a host with no web page is shown, not linked, and not called unlinked', () => {
  // Code Storage has no human web page (`repositoryWebUrl` returns null for it),
  // so the address is text. Claiming "Not linked yet" here would be false: the
  // project knows exactly where its code is.
  const out = renderRepositoryValue({
    connection: null,
    repoUrl: 'https://kortix.code.storage/9f3a.git',
  });
  expect(out).toContain('https://kortix.code.storage/9f3a.git');
  expect(out).not.toContain('<a ');
  expect(out).not.toContain('Not linked yet');
});

test('projectRepoFallback places both address forms main linked', () => {
  expect(projectRepoFallback('https://github.com/acme/project.git')).toEqual({
    provider: 'github',
    label: 'acme/project',
    webUrl: 'https://github.com/acme/project',
  });
  // `settings-view.tsx` on `main` matched `git@github.com:owner/repo` too.
  expect(projectRepoFallback('git@github.com:acme/project.git')).toEqual({
    provider: 'github',
    label: 'acme/project',
    webUrl: 'https://github.com/acme/project',
  });
  expect(projectRepoFallback('https://gitlab.com/acme/project')?.provider).toBe('gitlab');
});

test('projectRepoFallback never guesses a URL for a host it cannot place', () => {
  expect(projectRepoFallback('https://kortix.code.storage/9f3a.git')).toBeNull();
  expect(projectRepoFallback('https://git.example.com/acme/project.git')).toBeNull();
  expect(projectRepoFallback('')).toBeNull();
  expect(projectRepoFallback(null)).toBeNull();
  expect(projectRepoFallback('   ')).toBeNull();
  // A bare host with no owner/name is not a repository address.
  expect(projectRepoFallback('https://github.com/acme')).toBeNull();
});

test('the provider sentence follows the same fallback the value does', () => {
  // Without this the row would read "Hosted on Git." directly beside a GitHub
  // link, because `providerSentence` was fed `connection?.provider` alone.
  expect(code).toContain('providerSentence(repositoryProvider)');
  expect(code).toContain('projectRepoFallback(project.repo_url)?.provider');
  expect(code).toContain('<RepositoryValue connection={connection} repoUrl={project.repo_url} />');
});
