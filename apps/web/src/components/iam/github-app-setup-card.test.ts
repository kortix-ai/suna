import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const card = readFileSync(join(import.meta.dir, 'github-app-setup-card.tsx'), 'utf8');
const adminPage = readFileSync(
  join(import.meta.dir, '../../app/admin/git/page.tsx'),
  'utf8',
);
const accountHub = readFileSync(
  join(import.meta.dir, '../../features/accounts/hub/account-hub-content.tsx'),
  'utf8',
);
const connectedTab = readFileSync(
  join(import.meta.dir, '../../features/workspace/settings/tabs/connected-tab.tsx'),
  'utf8',
);

/** Source with comments stripped, the convention `advanced-fields.test.ts`
 *  uses: assertions run against what renders, not what the comments say. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 2026-09-16, production, ~6 min: the managed-git setup card rendered on
 * `Settings → <any account> → Git`, one card below the account's own GitHub
 * connections. A platform admin ran its manifest flow while looking at one
 * customer's settings. The callback overwrote
 * `kortix.platform_settings.managed_github_app` — the single instance-global
 * row every managed-git accessor reads before falling back to env — and all 39
 * accounts' GitHub installations stopped resolving at once.
 *
 * The rule: a surface that writes instance-global state never renders inside a
 * page scoped to one account.
 */
describe('the managed-git setup card is platform surface', () => {
  test('only /admin/git mounts it', () => {
    expect(adminPage).toContain('<GitHubAppSetupCard />');
    // `code` is the source with comments stripped — the account hub's comment
    // names the card while explaining why it is gone, which is the opposite of
    // rendering it.
    expect(stripComments(accountHub)).not.toContain('GitHubAppSetupCard');
    expect(stripComments(connectedTab)).not.toContain('GitHubAppSetupCard');
  });

  test('the page it lives on states the blast radius in words', () => {
    // The card's own title ("Managed GitHub") does not say that this one form
    // decides how EVERY project on the instance reaches GitHub.
    expect(adminPage).toContain("tI18nComplete.raw('text42888e8dc93e')");
  });

  test('the platform-admin-only status query is not exported to account surfaces', () => {
    // `GET /platform/github-app/status` 403s for an account admin. An account
    // surface that called it is what produced the card's old "hide the error
    // when it is a 403" branch. The account Git tab reads
    // `getManagedGitBackend()` instead.
    expect(card).toContain('function useGitHubAppStatus()');
    expect(card).not.toContain('export function useGitHubAppStatus');
    expect(accountHub).not.toContain('useGitHubAppStatus');
    expect(connectedTab).not.toContain('useGitHubAppStatus');
  });

  test('no permission branch of its own — /admin is the gate', () => {
    expect(card).not.toContain('canManage');
    expect(card).not.toContain('forbidden');
  });
});

describe('an env-owned identity is read-only', () => {
  test('mutability comes from the status, not from the auth mechanism', () => {
    // `source === 'env'` said how the App authenticates, which is a different
    // axis from whether the instance-global row may be written.
    expect(card).toContain('const envManaged = !status.mutable;');
    expect(card).toContain('const showSetup = !envManaged && (!status.configured || reconfiguring);');
    expect(card).not.toContain("status.source === 'env'");
  });

  test('it names the variables an operator actually edits', () => {
    expect(card).toContain('status.env_owned_by.length > 0');
  });

  test('a 409 from the same guard is handled, not echoed', () => {
    expect(card).toContain("err.data?.error === 'instance_identity_is_env_managed'");
    // All four mutations share one error path, so none of them can drift.
    expect([...card.matchAll(/onMutationError\(err,/g)]).toHaveLength(4);
  });
});
