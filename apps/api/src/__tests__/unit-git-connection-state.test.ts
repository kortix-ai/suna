import { describe, expect, test } from 'bun:test';

/**
 * The Reconnect-GitHub contract, asserted against the source.
 *
 * These are the two failures that stranded people: a stored App installation
 * that no longer mints tokens (which is what every installation looks like the
 * moment the App identity changes), and an install started from GitHub's own
 * App page, which arrives with no state at all. Both used to surface as an
 * opaque error; both must now be nameable by the client.
 */

const gitSource = await Bun.file(new URL('../projects/lib/git.ts', import.meta.url)).text();
const routeSource = await Bun.file(
  new URL('../projects/routes/r1.ts', import.meta.url),
).text();
const githubAppSource = await Bun.file(
  new URL('../platform/routes/github-app.ts', import.meta.url),
).text();

function resolverBody(): string {
  const start = gitSource.indexOf('export async function resolveProjectGitAuth');
  const end = gitSource.indexOf('export type ProjectGitConnectionState', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return gitSource.slice(start, end);
}

describe('project git connection state', () => {
  test('a BYO installation that cannot mint a token degrades instead of throwing', () => {
    const body = resolverBody();
    const mint = body.indexOf('createInstallationToken(installation.installationId');
    expect(mint).toBeGreaterThan(-1);

    // The mint must sit inside a try whose catch names the reason. Before this,
    // the call was bare: a 404 from GitHub threw out of a routine auth resolve.
    const tryBefore = body.lastIndexOf('try {', mint);
    expect(tryBefore).toBeGreaterThan(-1);
    const catchAfter = body.indexOf('} catch', mint);
    expect(catchAfter).toBeGreaterThan(mint);
    expect(body.slice(catchAfter)).toContain("reason: 'installation_unusable'");
  });

  test('every unavailable path names why, so the client can tell them apart', () => {
    const body = resolverBody();
    for (const reason of [
      'installation_missing',
      'installation_unusable',
      'installation_mismatch',
      'repo_url_unparseable',
      'managed_git_unavailable',
      'no_credential',
    ]) {
      expect(body + gitSource).toContain(`reason: '${reason}'`);
    }
    // No unlabelled dead end may remain.
    expect(body).not.toContain("return { authSource: 'none' };");
  });

  test('only an account-fixable reason offers an install URL', () => {
    const start = gitSource.indexOf('export async function resolveProjectGitConnection');
    expect(start).toBeGreaterThan(-1);
    const body = gitSource.slice(start);
    const guard = body.indexOf('if (!reconnectable)');
    const install = body.indexOf('createGitHubInstallationInstallUrl');
    expect(guard).toBeGreaterThan(-1);
    // The unavailable check short-circuits BEFORE an install URL is minted:
    // telling someone to reinstall cannot fix a server-side failure.
    expect(guard).toBeLessThan(install);
    expect(body).toContain("state: 'unavailable'");
    expect(body).toContain("state: 'reconnect_required'");
  });

  test('the route exposes the state without requiring a git operation first', () => {
    expect(routeSource).toContain("path: '/{projectId}/git/connection'");
    expect(routeSource).toContain('resolveProjectGitConnection');
    // A read-scoped caller can check their own connection; this must not demand
    // write, or the person who needs the prompt cannot see it.
    const route = routeSource.slice(routeSource.indexOf("path: '/{projectId}/git/connection'"));
    expect(route).toContain("loadProjectForUser(c, projectId, 'read')");
  });
});

describe('installing from GitHub instead of from Kortix', () => {
  test('a state-less install callback is reported as an install, not a bad state', () => {
    const start = githubAppSource.indexOf('const state = verifyGitHubAppInstallStatePayload');
    expect(start).toBeGreaterThan(-1);
    const body = githubAppSource.slice(start, start + 2500);

    const directInstall = body.indexOf("github: 'install_received'");
    const invalidState = body.indexOf("'invalid_state'");
    expect(directInstall).toBeGreaterThan(-1);
    // The no-state branch is checked FIRST, so a legitimate direct install can
    // never be reported as a tampered one.
    expect(directInstall).toBeLessThan(invalidState);
    expect(body).toContain("reason: 'direct_install'");
    // The installation id has to survive the redirect or the install is
    // unrecoverable — nothing else identifies it.
    expect(body).toContain("qs.set('installation_id'");
  });

  test('a genuinely rejected state is still an error', () => {
    expect(githubAppSource).toContain("if (action === 'reject') {");
    expect(githubAppSource).toContain("'invalid_state'");
  });
});
