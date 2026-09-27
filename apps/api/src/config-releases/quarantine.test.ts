/**
 * Project quarantine (spec, "Quarantine across the project"): the threshold,
 * the fallback assignment, and the clear-on-new-release rule. The ledger is
 * the in-memory twin of the DB one; the build is a fake keyed by commit, so
 * each test states the release IDs it expects.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitBackedProject } from '../projects/git/types';
import type { ConfigRelease } from './builder';
import { configReleaseId } from './builder';
import { ledgerVariant, resolveDesiredRelease, type DesiredReleaseDeps } from './desired';
import {
  __clearQuarantineMemoForTests,
  MemoryConfigReleaseLedger,
  PROJECT_QUARANTINE_SESSIONS,
  recordDaemonConfigReport,
} from './quarantine';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222221';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '22222222-2222-4222-8222-222222222223';
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);

const project: GitBackedProject = {
  projectId: PROJECT,
  repoUrl: '/nonexistent',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
};

/** A release per commit: tree `t<n>`, etag `e<n>`. */
function releaseAt(commit: string): ConfigRelease {
  const n = commit[0]!;
  const tree = n.repeat(40).replace(/^./, 'a');
  const etag = n.repeat(16);
  return {
    format: 'config-release-v1',
    release_id: configReleaseId(tree, etag),
    source_commit: commit,
    config_dir: '.kortix/opencode',
    config_tree_id: tree,
    archive: { url: `/v1/projects/${PROJECT}/config-archives/${tree}`, bytes: 10 },
    files: [],
    compiled_governance: '{}',
    compiled_governance_etag: etag,
    reason: null,
  };
}
const idAt = (commit: string) => releaseAt(commit).release_id!;

let ledger: MemoryConfigReleaseLedger;
let tip = C1;
const builds: string[] = [];
const deps = (): DesiredReleaseDeps => ({
  ledger,
  build: async (_project, commit) => {
    builds.push(commit);
    return releaseAt(commit);
  },
  resolveBase: async () => tip,
  loadRoster: async () => ({ enabled: [], defaultAgent: null, readable: true, governed: false }),
});

const desired = (recordAssignment = true) =>
  resolveDesiredRelease(
    { project, baseRef: 'main', sessionAgent: null, repositoryAccess: true, recordAssignment },
    deps(),
  );

/** A session daemon reports what it runs, as GET /config or a reload reads it. */
const report = (sessionId: string, fields: { running: string | null; failed?: string | null; proven?: boolean; source?: 'release' | 'image-default' }) =>
  recordDaemonConfigReport(
    {
      projectId: PROJECT,
      sessionId,
      report: {
        release_id: fields.running,
        desired_release_id: null,
        source: fields.source ?? 'release',
        mode: 'follow-base',
        proven: fields.proven ?? true,
        fallback_reason: fields.failed ? 'replacement did not serve GET /agent within 90 s' : null,
        failed_release_id: fields.failed ?? null,
      },
    },
    ledger,
  );

beforeEach(() => {
  ledger = new MemoryConfigReleaseLedger();
  tip = C1;
  builds.length = 0;
  __clearQuarantineMemoForTests();
});

describe('project quarantine', () => {
  test('the threshold is 2 distinct sessions', () => {
    expect(PROJECT_QUARANTINE_SESSIONS).toBe(2);
  });

  test('one failing session does not quarantine; a second distinct one does', async () => {
    // C1 is assigned and proven by S1.
    expect((await desired()).descriptor.release_id).toBe(idAt(C1));
    await report(S1, { running: idAt(C1) });

    // Base moves to a broken C2.
    tip = C2;
    expect((await desired()).descriptor.release_id).toBe(idAt(C2));
    await report(S1, { running: idAt(C1), failed: idAt(C2) });
    // The same session reporting again is one failure, not two.
    await report(S1, { running: idAt(C1), failed: idAt(C2) });
    __clearQuarantineMemoForTests();
    await report(S1, { running: idAt(C1), failed: idAt(C2) });
    expect((await desired()).descriptor.release_id).toBe(idAt(C2));

    await report(S2, { running: idAt(C1), failed: idAt(C2) });
    const third = await desired();
    expect(third.quarantinedReleaseId).toBe(idAt(C2));
    expect(third.descriptor.release_id).toBe(idAt(C1));
    expect(third.descriptor.source_commit).toBe(C1);
    expect(third.baseSha).toBe(C2);
  });

  test('the fallback is the newest proven release, never an unproven or quarantined one', async () => {
    await desired();
    await report(S1, { running: idAt(C1) });
    tip = C2;
    await desired(); // assigned, never proven
    tip = C3;
    await desired();
    await report(S1, { running: idAt(C1), failed: idAt(C3) });
    await report(S2, { running: idAt(C1), failed: idAt(C3) });
    expect((await desired()).descriptor.release_id).toBe(idAt(C1));
  });

  test('a report without a running release proves nothing', async () => {
    // The box fell to the image default with no release id: there is nothing
    // to prove, so the quarantined release stays assigned.
    await desired();
    await report(S1, { running: null, source: 'image-default' });
    tip = C2;
    await desired();
    await report(S1, { running: null, failed: idAt(C2) });
    await report(S2, { running: null, failed: idAt(C2) });
    // No proven release: the quarantined release stays assigned.
    const result = await desired();
    expect(result.descriptor.release_id).toBe(idAt(C2));
    expect(result.quarantinedReleaseId).toBeNull();
  });

  test('a new base commit with a new release ID is assignable again', async () => {
    await desired();
    await report(S1, { running: idAt(C1) });
    tip = C2;
    await desired();
    await report(S1, { running: idAt(C1), failed: idAt(C2) });
    await report(S2, { running: idAt(C1), failed: idAt(C2) });
    expect((await desired()).descriptor.release_id).toBe(idAt(C1));

    tip = C3; // the fix lands
    const fixed = await desired();
    expect(fixed.descriptor.release_id).toBe(idAt(C3));
    expect(fixed.quarantinedReleaseId).toBeNull();
    // A third session boots on it.
    await report(S3, { running: idAt(C3) });
    expect(ledger.assigned.find((row) => row.releaseId === idAt(C3))?.provenAt).not.toBeNull();
  });

  test('a human read does not record an assignment', async () => {
    await desired(false);
    expect(ledger.assigned).toEqual([]);
  });

  test('a session without repository access has its own variant key', () => {
    expect(ledgerVariant('project', true)).toBe('project');
    expect(ledgerVariant('agent:kortix', false)).toBe('agent:kortix#governance-only');
  });
});

describe('recordDaemonConfigReport', () => {
  test('ignores a null report, non-UUID IDs, and junk release IDs', async () => {
    await recordDaemonConfigReport({ projectId: PROJECT, sessionId: S1, report: null }, ledger);
    await recordDaemonConfigReport(
      {
        projectId: 'not-a-uuid',
        sessionId: S1,
        report: { release_id: idAt(C1), desired_release_id: null, source: 'release', mode: null, proven: true, fallback_reason: null, failed_release_id: idAt(C2) },
      },
      ledger,
    );
    expect(ledger.failures).toEqual([]);
  });

  test('never throws when the ledger fails', async () => {
    const broken = new MemoryConfigReleaseLedger();
    broken.recordFailure = async () => {
      throw new Error('db down');
    };
    await recordDaemonConfigReport(
      {
        projectId: PROJECT,
        sessionId: S1,
        report: { release_id: null, desired_release_id: null, source: 'release', mode: null, proven: false, fallback_reason: 'x', failed_release_id: idAt(C2) },
      },
      broken,
    );
  });
});
