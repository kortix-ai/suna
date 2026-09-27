/**
 * GET /:projectId/branches returned every remote branch — 977KB on a busy
 * prod project, dominated by thousands of auto-created session branches
 * (createRemoteSessionBranch names each one after the session's own UUID,
 * validated by isUuid before the branch is cut — see ../lib/sessions.ts).
 * No human picks one of those by name; every UI branch picker already
 * limits itself to a bounded human-relevant subset after fetching the
 * whole thing.
 *
 * `filterBranchesForResponse` is the pure, unit-testable core of the fix:
 * exclude session branches by default, cap the result, and support a
 * substring search — with an explicit opt-in escape hatch for a caller that
 * genuinely wants everything (the CLI's full-table listing).
 */
import { describe, expect, test } from 'bun:test';
import {
  BRANCH_LIST_DEFAULT_LIMIT,
  BRANCH_LIST_MAX_LIMIT,
  filterBranchesForResponse,
  isSessionBranchName,
} from './branches';
import type { GitBranchInfo } from './types';

function branch(name: string, overrides: Partial<GitBranchInfo> = {}): GitBranchInfo {
  return {
    name,
    is_default: false,
    tip: 'a'.repeat(40),
    tip_short: 'aaaaaaa',
    subject: '',
    committer_name: '',
    committer_email: '',
    committed_at: '',
    ahead: null,
    behind: null,
    ...overrides,
  };
}

describe('isSessionBranchName', () => {
  test('matches a session id (UUID) branch name', () => {
    expect(isSessionBranchName('9b1f0c2a-4b7e-4a3d-9c1e-2f6a7b8c9d0e')).toBe(true);
    expect(isSessionBranchName('9B1F0C2A-4B7E-4A3D-9C1E-2F6A7B8C9D0E')).toBe(true);
  });

  test('does not match a human-named branch', () => {
    expect(isSessionBranchName('main')).toBe(false);
    expect(isSessionBranchName('feature/new-login')).toBe(false);
    expect(isSessionBranchName('release-2026-09')).toBe(false);
  });

  test('does not match a UUID embedded in a longer name', () => {
    expect(isSessionBranchName('backup/9b1f0c2a-4b7e-4a3d-9c1e-2f6a7b8c9d0e')).toBe(false);
  });
});

describe('filterBranchesForResponse', () => {
  const main = branch('main', { is_default: true });
  const feature = branch('feature/login');
  const sessionA = branch('9b1f0c2a-4b7e-4a3d-9c1e-2f6a7b8c9d0e');
  const sessionB = branch('1a2b3c4d-5e6f-4789-90ab-cdef01234567');
  const all = [main, feature, sessionA, sessionB];

  test('keeps session branches by default: the Files and CR pickers list them', () => {
    const result = filterBranchesForResponse(all);
    expect(result.map((b) => b.name)).toEqual(all.map((b) => b.name));
  });

  test('includeSessionBranches: false drops them for a default-branch picker', () => {
    const result = filterBranchesForResponse(all, { includeSessionBranches: false });
    expect(result.map((b) => b.name)).toEqual(['main', 'feature/login']);
  });

  test('never excludes the default branch even if it looked session-shaped', () => {
    const defaultLooksLikeSession = branch('9b1f0c2a-4b7e-4a3d-9c1e-2f6a7b8c9d0e', {
      is_default: true,
    });
    const result = filterBranchesForResponse([defaultLooksLikeSession, sessionB], {
      includeSessionBranches: false,
    });
    expect(result).toEqual([defaultLooksLikeSession]);
  });

  test('the cap never hides the default branch', () => {
    const many = Array.from({ length: 10 }, (_, i) => branch(`feature-${i}`));
    const result = filterBranchesForResponse([...many, main], { limit: 3 });
    expect(result.map((b) => b.name)).toEqual(['feature-0', 'feature-1', 'feature-2', 'main']);
  });

  test('q applies a case-insensitive substring filter', () => {
    const result = filterBranchesForResponse(all, { q: 'LOGIN', includeSessionBranches: true });
    expect(result.map((b) => b.name)).toEqual(['feature/login']);
  });

  test('limit caps the result and is itself capped at BRANCH_LIST_MAX_LIMIT', () => {
    const many = Array.from({ length: 10 }, (_, i) => branch(`feature-${i}`));
    expect(filterBranchesForResponse(many, { limit: 3 })).toHaveLength(3);
    expect(filterBranchesForResponse(many, { limit: BRANCH_LIST_MAX_LIMIT + 1_000_000 })).toHaveLength(
      many.length,
    );
  });

  test('the default limit is a real cap, not unbounded', () => {
    const many = Array.from({ length: BRANCH_LIST_DEFAULT_LIMIT + 50 }, (_, i) =>
      branch(`feature-${i}`),
    );
    expect(filterBranchesForResponse(many)).toHaveLength(BRANCH_LIST_DEFAULT_LIMIT);
  });
});
