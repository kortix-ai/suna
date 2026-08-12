import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
