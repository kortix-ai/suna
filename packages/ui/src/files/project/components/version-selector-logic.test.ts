import { describe, expect, test } from 'bun:test';
import type { ProjectBranch, ProjectBranchSession } from '@kortix/sdk';
import { groupVersions, versionMatches, versionTitle } from './version-selector-logic';

const SESSION = '3f6c2a1e-8b4d-4c7a-9e2f-1a2b3c4d5e6f';

function branch(name: string, session?: Partial<ProjectBranchSession>, isDefault = false): ProjectBranch {
  return {
    name,
    is_default: isDefault,
    tip: 'a'.repeat(40),
    tip_short: 'aaaaaaa',
    subject: 'Add store page',
    committer_name: '',
    committer_email: '',
    committed_at: '2026-10-22T08:00:00.000Z',
    ahead: 1,
    behind: 0,
    ...(session
      ? { session: { title: null, agent_name: null, archived: false, deleted: false, ...session } }
      : {}),
  };
}

describe('the name a version shows', () => {
  test("a session branch shows its session's title, not its id", () => {
    expect(versionTitle(branch(SESSION, { title: 'Draft cable tray product page' }))).toBe(
      'Draft cable tray product page',
    );
  });

  test('a branch without a title shows its name', () => {
    expect(versionTitle(branch(SESSION, { title: null }))).toBe(SESSION);
    expect(versionTitle(branch(SESSION, { title: '   ' }))).toBe(SESSION);
    expect(versionTitle(branch('feature/pricing'))).toBe('feature/pricing');
  });
});

describe('finding a version', () => {
  const titled = branch(SESSION, { title: 'Draft cable tray product page', agent_name: 'store-builder' });

  test('matches the title, the agent, the id and the last commit, ignoring case', () => {
    for (const q of ['cable', 'STORE-BUILDER', SESSION.slice(0, 8), 'store page', '']) {
      expect(versionMatches(titled, q)).toBe(true);
    }
    expect(versionMatches(titled, 'marketing')).toBe(false);
  });
});

describe('grouping versions', () => {
  test('main first, then live work, then what the person archived or deleted, each in served order', () => {
    const main = branch('main', undefined, true);
    const live = branch('a0000000-0000-4000-8000-000000000001', { title: 'Live' });
    const named = branch('feature/pricing');
    const archived = branch('a0000000-0000-4000-8000-000000000002', { title: 'Setup', archived: true });
    const deleted = branch('a0000000-0000-4000-8000-000000000003', { title: 'Old', deleted: true });
    expect(groupVersions([archived, live, main, deleted, named])).toEqual({
      primary: [main],
      others: [live, named],
      archived: [archived, deleted],
    });
  });
});
