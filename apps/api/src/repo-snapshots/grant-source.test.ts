/**
 * The grant source is the project's DEFAULT BRANCH, and nothing else.
 *
 * `loadProjectAgents` has always read `project.defaultBranch`. That is a policy
 * boundary: a session running on a feature branch must not be able to widen its
 * own secrets, connectors or Kortix-CLI grant by editing `kortix.yaml` on that
 * branch. Moving the read from Git to a prepared archive must preserve it
 * exactly — handing an authorization read the SESSION's pinned snapshot would
 * reproduce the hole with the network removed, which is worse than the Git read
 * it replaced.
 *
 * These tests pin the shape of that guarantee at the seam where it could be
 * lost. The live-database half lives in
 * `__tests__/integration-repo-snapshot-grant-source.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

describe('resolveDefaultBranchGrantSnapshot', () => {
  test('takes only the project — a session ref cannot be passed in', async () => {
    const { resolveDefaultBranchGrantSnapshot } = await import('./session-pin');
    // One parameter. There is no argument through which a caller could hand it
    // the session's base_ref, its requested SHA, or its pinned row.
    expect(resolveDefaultBranchGrantSnapshot.length).toBe(1);
  });

  test('resolves the ref row for defaultBranch, never for a session ref', async () => {
    const source = await Bun.file(new URL('./session-pin.ts', import.meta.url)).text();
    const start = source.indexOf('export async function resolveDefaultBranchGrantSnapshot');
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('project.defaultBranch');
    // The two inputs that carry a session's own ref must not appear.
    expect(body).not.toContain('baseRef');
    expect(body).not.toContain('requestedSha');
    expect(body).not.toContain('input.ref');
  });
});

describe('every authorization read uses the default-branch source', () => {
  test('session creation resolves the grant source separately from the workspace pin', async () => {
    const source = await Bun.file(
      new URL('../projects/lib/sessions.ts', import.meta.url),
    ).text();
    // Two DISTINCT resolutions. Where base_ref is the default branch they land
    // on the same row; where they differ, only the grant one may decide authority.
    expect(source).toContain('const pinnedSnapshotRow = governingPin?.row ?? null;');
    expect(source).toContain(
      'const grantSnapshotRow = governingPin ? await resolveDefaultBranchGrantSnapshot(project) : null;',
    );
    // Agent discovery and the secrets grant both take the GRANT source.
    expect(source).toContain('forceRefresh: !grantSnapshotRow,');
    expect(source).toContain('snapshot: grantSnapshotRow,');
    expect(source).toContain('snapshot: input.grantSnapshotRow,');
    // The workspace pin stays with the things that are legitimately per-session:
    // the compiled agent config and the runtime/manifest read at the session ref.
    expect(source).toContain('input.repoSnapshotRow,');
    expect(source).toContain('resolveManifestRuntime(project, baseRef, pinnedSnapshotRow)');
  });

  test('token minting and the network boundary both take the grant source', async () => {
    const source = await Bun.file(
      new URL('../platform/services/session-sandbox.ts', import.meta.url),
    ).text();
    expect(source).toContain('resolveAgentGrant(opts.agentName, opts.gitProject, opts.grantSnapshotRow)');
    expect(source).toContain(
      'await resolveSessionNetworkBoundary(projectId, sandbox.sandboxId, null, opts.grantSnapshotRow ?? null);',
    );
    // The workspace pin is NOT what either of them receives.
    expect(source).not.toContain('resolveAgentGrant(opts.agentName, opts.gitProject, opts.repoSnapshotRow)');
    expect(source).not.toContain(
      'resolveSessionNetworkBoundary(projectId, sandbox.sandboxId, null, opts.repoSnapshotRow',
    );
  });

  test('required mode fails closed rather than reading the grant over Git', async () => {
    const source = await Bun.file(
      new URL('../projects/lib/sessions.ts', import.meta.url),
    ).text();
    expect(source).toContain("code: 'REPO_SNAPSHOT_GRANT_SOURCE_PREPARING'");
    // Per-project, not global: a canary cohort decides whether THIS project
    // fails closed. See `cohort.test.ts`.
    expect(source).toContain("repoSnapshotModeForProject(project.projectId) === 'required'");
  });
});

describe('normalizeRefKey', () => {
  test('collapses the two spellings of one branch', async () => {
    const { normalizeRefKey } = await import('./format');
    // A GitHub push payload says `refs/heads/main`; a project default branch, a
    // session base_ref and a proxy push all say `main`. Two rows for one branch
    // meant the pin never found what the webhook wrote.
    expect(normalizeRefKey('refs/heads/main')).toBe('main');
    expect(normalizeRefKey('main')).toBe('main');
    expect(normalizeRefKey('refs/heads/feature/a-b')).toBe('feature/a-b');
    expect(normalizeRefKey('  refs/heads/main  ')).toBe('main');
  });

  // How the STORE uses this — resolving whichever spelling a row is stored
  // under, under a per-branch lock so the key cannot move mid-write — is proved
  // against the real table in
  // `__tests__/integration-repo-snapshot-ref-alias.test.ts`. A source-string
  // assertion here would only pin the shape of the code, not the behaviour.
  test('leaves a non-branch ref alone — it is a different ref', async () => {
    const { normalizeRefKey } = await import('./format');
    expect(normalizeRefKey('refs/tags/v1')).toBe('refs/tags/v1');
    expect(normalizeRefKey('refs/notes/commits')).toBe('refs/notes/commits');
  });

});
