/**
 * The canary cohort.
 *
 * A rollout puts a handful of real projects on `prefer` while the rest of the
 * deployment keeps its existing behaviour. Getting this wrong in either
 * direction is serious: a project outside the cohort that takes the prepared
 * path is an unannounced rollout, and one inside it that does not is a canary
 * that proves nothing.
 *
 * Run:
 *   cd apps/api && bun test --isolate src/repo-snapshots/cohort.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function configure(mode: string, cohort?: string): void {
  process.env.KORTIX_REPO_SNAPSHOT_MODE = mode;
  process.env.KORTIX_REPO_SNAPSHOT_BUCKET = 'kortix-repo-snapshots';
  if (cohort === undefined) delete process.env.KORTIX_REPO_SNAPSHOT_COHORT;
  else process.env.KORTIX_REPO_SNAPSHOT_COHORT = cohort;
}

afterEach(() => {
  delete process.env.KORTIX_REPO_SNAPSHOT_MODE;
  delete process.env.KORTIX_REPO_SNAPSHOT_COHORT;
  delete process.env.KORTIX_REPO_SNAPSHOT_BUCKET;
});

/**
 * The real decision functions, fed the environment under test.
 *
 * `config` parses the environment once per process, so the wrapper that reads
 * it cannot be driven from a test — but the decision itself is pure, and it is
 * the same function `repoSnapshotModeForProject` calls.
 */
async function modeFor(projectId: string): Promise<string> {
  const { applyRepoSnapshotCohort, parseRepoSnapshotCohort, resolveRepoSnapshotMode } = await import(
    './descriptor'
  );
  return applyRepoSnapshotCohort(
    resolveRepoSnapshotMode(
      (process.env.KORTIX_REPO_SNAPSHOT_MODE ?? 'off') as never,
      !!process.env.KORTIX_REPO_SNAPSHOT_BUCKET,
    ),
    projectId,
    parseRepoSnapshotCohort(process.env.KORTIX_REPO_SNAPSHOT_COHORT),
  );
}

describe('repoSnapshotCohort', () => {
  test('an unset cohort means every project', async () => {
    const { parseRepoSnapshotCohort } = await import('./descriptor');
    expect(parseRepoSnapshotCohort('')).toBeNull();
    configure('prefer');
    expect(await modeFor(A)).toBe('prefer');
    expect(await modeFor(B)).toBe('prefer');
  });

  test('`*` is the explicit spelling of the same thing', async () => {
    const { parseRepoSnapshotCohort } = await import('./descriptor');
    expect(parseRepoSnapshotCohort('*')).toBeNull();
    expect(parseRepoSnapshotCohort('  ')).toBeNull();
    expect(parseRepoSnapshotCohort(undefined)).toBeNull();
    configure('prefer', '*');
    expect(await modeFor(A)).toBe('prefer');
  });

  test('every entry point resolves the mode through the cohort', async () => {
    // The three places a project can enter the prepared path. A call site left
    // on the global mode would roll the feature out to the whole deployment.
    for (const file of ['session-pin.ts', '../projects/lib/sessions.ts', '../git-proxy/index.ts']) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).not.toContain('repoSnapshotMode()');
      expect(source).toContain('repoSnapshotModeForProject(');
    }
  });

  test('only the listed projects are in the cohort', async () => {
    configure('prefer', `${A}, ${B.toUpperCase()}`);
    expect(await modeFor(A)).toBe('prefer');
    expect(await modeFor(B)).toBe('prefer');
    expect(await modeFor('33333333-3333-4333-8333-333333333333')).toBe('off');
  });

  test('the cohort cannot switch a project on when the deployment is off', async () => {
    configure('off', A);
    expect(await modeFor(A)).toBe('off');
  });

  test('`required` still applies to the cohort only', async () => {
    configure('required', A);
    expect(await modeFor(A)).toBe('required');
    // A project outside it keeps the Git path instead of failing closed — which
    // is the whole point of a canary.
    expect(await modeFor(B)).toBe('off');
  });

  test('whitespace and empty entries are ignored', async () => {
    configure('prefer', ` , ${A} ,, `);
    expect(await modeFor(A)).toBe('prefer');
    expect(await modeFor(B)).toBe('off');
  });
});
