/**
 * Which sessions receive a snapshot descriptor, and which must never.
 *
 * The archive is the COMPLETE repository. Storing it server-side must not hand
 * a restricted agent files its workspace mode withholds, and a resumed session
 * must keep its own workspace rather than being overlaid with a fresh base.
 */
import { describe, expect, test } from 'bun:test';
import { buildSessionRuntimeEnv } from './session-runtime-env';

const SNAPSHOT_ENV = {
  KORTIX_REPO_SNAPSHOT_MODE: 'prefer',
  KORTIX_REPO_SNAPSHOT_URL: 'https://example.invalid/a.tar.gz?X-Amz-Signature=x',
  KORTIX_REPO_SNAPSHOT_SHA256: 'a'.repeat(64),
  KORTIX_REPO_SNAPSHOT_COMPRESSION: 'gzip',
  KORTIX_REPO_SNAPSHOT_COMMIT_SHA: 'b'.repeat(40),
  KORTIX_REPO_SNAPSHOT_REPOSITORY_ID: '1296269',
  KORTIX_REPO_SNAPSHOT_COMPRESSED_BYTES: '1000',
  KORTIX_REPO_SNAPSHOT_EXPANDED_BYTES: '4000',
  KORTIX_REPO_SNAPSHOT_ENTRY_COUNT: '12',
};

function env(overrides: Parameters<typeof buildSessionRuntimeEnv>[0] extends infer T ? Partial<T> : never) {
  return buildSessionRuntimeEnv({
    projectId: 'p1',
    sessionId: 's1',
    repoUrl: 'https://api.example/v1/git/p1.git',
    baseRef: 'main',
    agentName: 'kortix',
    apiUrl: 'https://api.example/v1',
    freshSession: true,
    repoSnapshotEnv: SNAPSHOT_ENV,
    ...overrides,
  } as Parameters<typeof buildSessionRuntimeEnv>[0]);
}

function snapshotKeys(record: Record<string, string>): string[] {
  return Object.keys(record).filter((key) => key.startsWith('KORTIX_REPO_SNAPSHOT_'));
}

describe('repository snapshot session env', () => {
  test('a fresh full-repository session receives the pinned descriptor', () => {
    const result = env({});
    expect(result.KORTIX_REPO_SNAPSHOT_COMMIT_SHA).toBe('b'.repeat(40));
    expect(result.KORTIX_REPO_SNAPSHOT_MODE).toBe('prefer');
    expect(result.KORTIX_PROJECT_AUTO_CLONE).toBe('1');
  });

  test('a restricted workspace never receives the archive', () => {
    // A workspace mode that withholds the repository must also withhold the
    // snapshot: the archive IS the whole repository.
    const restricted = env({ workspaceMode: 'read' });
    expect(snapshotKeys(restricted)).toEqual([]);
    expect(restricted.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(restricted.KORTIX_REPO_URL).toBeUndefined();
  });

  test('a resumed session keeps its own workspace', () => {
    const resumed = env({ freshSession: false, restoreSessionBranch: true });
    expect(snapshotKeys(resumed)).toEqual([]);
    expect(resumed.KORTIX_SESSION_BRANCH_RESTORE).toBe('1');
  });

  test('no pinned revision leaves the sandbox env byte-for-byte unchanged', () => {
    const withFeature = env({ repoSnapshotEnv: {} });
    const withoutFeature = env({ repoSnapshotEnv: undefined });
    expect(snapshotKeys(withFeature)).toEqual([]);
    expect(withFeature).toEqual(withoutFeature);
  });

  test('snapshot transport does not enable the compiled-boot experiment', () => {
    // The two flags are separate on purpose: compiled boot also swaps in the
    // experimental OpenCode launcher.
    const result = env({ compiledBootMode: 'off' });
    expect(result.KORTIX_REPO_SNAPSHOT_MODE).toBe('prefer');
    expect(result.KORTIX_COMPILED_BOOT_MODE).toBeUndefined();
    expect(result.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined();
  });

  test('the signed URL is passed through verbatim and nothing else leaks', () => {
    const result = env({});
    expect(result.KORTIX_REPO_SNAPSHOT_URL).toBe(SNAPSHOT_ENV.KORTIX_REPO_SNAPSHOT_URL);
    // No bucket, key or credential name reaches the sandbox.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/BUCKET|ACCESS_KEY|SECRET_ACCESS/);
  });
});
