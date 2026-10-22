import { describe, expect, test } from 'bun:test';

import type { ProjectBranch, ProjectBranchSession } from '@kortix/sdk';
import { orderVersions, versionLabel } from './version-label';

const SESSION = '3f6c2a1e-8b4d-4c7a-9e2f-1a2b3c4d5e6f';

function branch(name: string, committedAt: string, session?: Partial<ProjectBranchSession>): ProjectBranch {
  return {
    name,
    is_default: name === 'main',
    tip: 'a'.repeat(40),
    tip_short: 'aaaaaaa',
    subject: 'commit',
    committer_name: '',
    committer_email: '',
    committed_at: committedAt,
    ahead: null,
    behind: null,
    ...(session ? { session: { title: null, agent_name: null, archived: false, deleted: false, ...session } } : {}),
  };
}

describe('versionLabel', () => {
  test("a session branch reads as its session's title", () => {
    const branches = [branch(SESSION, '2026-10-22T08:00:00Z', { title: 'Draft cable tray product page' })];
    expect(versionLabel(SESSION, branches)).toBe('Draft cable tray product page');
  });

  test('without a title, a session id shortens to 8 characters and a named branch stays whole', () => {
    expect(versionLabel(SESSION, [branch(SESSION, '2026-10-22T08:00:00Z', { title: '  ' })])).toBe('3f6c2a1e');
    expect(versionLabel(SESSION, undefined)).toBe('3f6c2a1e');
    expect(versionLabel('feature/pricing', [])).toBe('feature/pricing');
  });
});

describe('orderVersions', () => {
  test('the default branch first, live work newest first, archived or deleted work last', () => {
    const main = branch('main', '2026-10-01T00:00:00Z');
    const older = branch('a0000000-0000-4000-8000-000000000001', '2026-10-20T00:00:00Z', { title: 'Older' });
    const newer = branch('a0000000-0000-4000-8000-000000000002', '2026-10-21T00:00:00Z', { title: 'Newer' });
    const archived = branch('a0000000-0000-4000-8000-000000000003', '2026-10-22T00:00:00Z', { archived: true });
    const deleted = branch('a0000000-0000-4000-8000-000000000004', '2026-10-22T01:00:00Z', { deleted: true });
    expect(orderVersions([archived, older, deleted, main, newer], 'main').map((b) => b.name)).toEqual([
      main.name,
      newer.name,
      older.name,
      deleted.name,
      archived.name,
    ]);
  });
});
