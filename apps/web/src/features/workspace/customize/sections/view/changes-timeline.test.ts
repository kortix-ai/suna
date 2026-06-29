import { describe, expect, test } from 'bun:test';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import type { ProjectCommit } from '@/lib/projects-client';
import {
  KORTIX_AGENT_EMAIL,
  buildTimeline,
  commitTime,
  crTime,
  dayLabel,
  groupTimeline,
  isKortixAgent,
} from './changes-timeline';

function localMidday(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12).getTime();
}

function localIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString();
}

const REF = new Date(2026, 5, 25, 15);

function commit(overrides: Partial<ProjectCommit> = {}): ProjectCommit {
  return {
    hash: 'abc123',
    short_hash: 'abc123',
    parents: [],
    author_name: 'Jane',
    author_email: 'jane@example.com',
    authored_at: '2026-06-29T10:00:00.000Z',
    committer_name: 'Jane',
    committer_email: 'jane@example.com',
    committed_at: '2026-06-29T10:00:00.000Z',
    subject: 'Save work',
    body: '',
    ...overrides,
  };
}

function changeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    cr_id: 'cr-1',
    account_id: 'acct',
    project_id: 'proj',
    number: 1,
    title: 'Add feature',
    description: '',
    base_ref: 'main',
    head_ref: 'feat',
    status: 'open',
    head_commit_sha: null,
    base_commit_sha: null,
    origin_session_id: null,
    created_by: 'user',
    merged_at: null,
    merged_by: null,
    merge_commit_sha: null,
    closed_at: null,
    closed_by: null,
    metadata: {},
    created_at: '2026-06-29T09:00:00.000Z',
    updated_at: '2026-06-29T09:00:00.000Z',
    ...overrides,
  };
}

describe('isKortixAgent', () => {
  test('matches the stable sandbox agent email', () => {
    expect(isKortixAgent(commit({ author_email: KORTIX_AGENT_EMAIL, author_name: 'Anyone' }))).toBe(
      true,
    );
  });

  test('matches legacy display names case-insensitively', () => {
    expect(isKortixAgent(commit({ author_email: 'other@example.com', author_name: 'Kortix Agent' }))).toBe(
      true,
    );
    expect(isKortixAgent(commit({ author_email: 'other@example.com', author_name: 'Cortex Agent' }))).toBe(
      true,
    );
  });

  test('does not match human authors', () => {
    expect(isKortixAgent(commit({ author_email: 'jane@example.com', author_name: 'Jane' }))).toBe(
      false,
    );
  });
});

describe('commitTime', () => {
  test('prefers committed_at over authored_at', () => {
    const c = commit({
      committed_at: '2026-06-28T12:00:00.000Z',
      authored_at: '2026-06-27T12:00:00.000Z',
    });
    expect(commitTime(c)).toBe(Date.parse('2026-06-28T12:00:00.000Z'));
  });

  test('falls back to authored_at when committed_at is empty', () => {
    const c = commit({ committed_at: '', authored_at: '2026-06-27T12:00:00.000Z' });
    expect(commitTime(c)).toBe(Date.parse('2026-06-27T12:00:00.000Z'));
  });
});

describe('crTime', () => {
  test('uses created_at for open change requests', () => {
    expect(crTime(changeRequest({ status: 'open', created_at: '2026-06-20T08:00:00.000Z' }))).toBe(
      Date.parse('2026-06-20T08:00:00.000Z'),
    );
  });

  test('uses merged_at for merged change requests', () => {
    expect(
      crTime(
        changeRequest({
          status: 'merged',
          created_at: '2026-06-20T08:00:00.000Z',
          merged_at: '2026-06-25T08:00:00.000Z',
        }),
      ),
    ).toBe(Date.parse('2026-06-25T08:00:00.000Z'));
  });

  test('uses closed_at for closed change requests', () => {
    expect(
      crTime(
        changeRequest({
          status: 'closed',
          created_at: '2026-06-20T08:00:00.000Z',
          closed_at: '2026-06-24T08:00:00.000Z',
        }),
      ),
    ).toBe(Date.parse('2026-06-24T08:00:00.000Z'));
  });
});

describe('dayLabel', () => {
  test('labels today, yesterday, this week, and older dates', () => {
    expect(dayLabel(localMidday(2026, 6, 25), REF)).toBe('Today');
    expect(dayLabel(localMidday(2026, 6, 24), REF)).toBe('Yesterday');
    expect(dayLabel(localMidday(2026, 6, 23), REF)).toBe('This week');
    expect(dayLabel(localMidday(2026, 5, 10), REF)).toMatch(/May 2026/);
  });
});

describe('buildTimeline', () => {
  test('merges checkpoints and change requests with stable keys', () => {
    const commits = [commit({ hash: 'sha1' }), commit({ hash: 'sha2' })];
    const crs = [changeRequest({ cr_id: 'cr-a' })];
    const timeline = buildTimeline(commits, crs);
    expect(timeline).toHaveLength(3);
    expect(timeline.map((item) => item.key)).toEqual(['cp:sha1', 'cp:sha2', 'cr:cr-a']);
    expect(timeline.filter((item) => item.kind === 'checkpoint')).toHaveLength(2);
    expect(timeline.filter((item) => item.kind === 'cr')).toHaveLength(1);
  });
});

describe('groupTimeline', () => {
  test('sorts newest first and buckets by day label order of first appearance', () => {
    const timeline = buildTimeline(
      [
        commit({ hash: 'old', committed_at: localIso(2026, 5, 10) }),
        commit({ hash: 'today', committed_at: localIso(2026, 6, 25) }),
      ],
      [
        changeRequest({
          cr_id: 'cr-yesterday',
          status: 'merged',
          merged_at: localIso(2026, 6, 24),
        }),
      ],
    );
    const groups = groupTimeline(timeline, REF);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'May 2026']);
    expect(groups[0]?.items.map((item) => item.key)).toEqual(['cp:today']);
    expect(groups[1]?.items.map((item) => item.key)).toEqual(['cr:cr-yesterday']);
    expect(groups[2]?.items.map((item) => item.key)).toEqual(['cp:old']);
  });
});
