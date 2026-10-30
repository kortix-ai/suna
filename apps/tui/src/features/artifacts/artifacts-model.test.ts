import { describe, expect, test } from 'bun:test';

import {
  type ArtifactLike,
  type ArtifactRow,
  artifactWebUrl,
  filterArtifactRows,
  orderRows,
  toArtifactRow,
  unavailableReason,
} from './artifacts-model.ts';

const artifact = (over: Partial<ArtifactLike> = {}): ArtifactLike => ({
  artifact_id: 'a1',
  title: 'Q3 plan',
  description: null,
  type: 'doc',
  path: '/workspace/plan.md',
  entry: 'plan.md',
  visibility: 'project',
  pinned: false,
  can_manage: true,
  created_by: { name: 'Ada', email: 'ada@example.test' },
  created_by_session_id: 's1',
  web_url: 'https://app.example.test/projects/p1/artifacts/a1',
  public_url: null,
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const row = (over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  ...toArtifactRow(artifact(), 'https://app.example.test', 'p1'),
  ...over,
});

describe('toArtifactRow', () => {
  test('reads the author name, then the email, then nothing', () => {
    const base = 'https://app.example.test';
    expect(toArtifactRow(artifact(), base, 'p1').author).toBe('Ada');
    expect(
      toArtifactRow(artifact({ created_by: { name: null, email: 'x@example.test' } }), base, 'p1')
        .author,
    ).toBe('x@example.test');
    expect(
      toArtifactRow(artifact({ created_by: { name: null, email: null } }), base, 'p1').author,
    ).toBe('');
  });

  test('an unparseable date is NaN, not a thrown error', () => {
    expect(toArtifactRow(artifact({ updated_at: 'nope' }), 'https://x.test', 'p1').updatedMs).toBeNaN();
  });
});

describe('artifactWebUrl', () => {
  test('an absolute web_url wins; a relative one joins the origin; none builds the route', () => {
    expect(artifactWebUrl('https://a.test/x', 'https://w.test/', 'p', 'a')).toBe('https://a.test/x');
    expect(artifactWebUrl('/projects/p/artifacts/a', 'https://w.test/', 'p', 'a')).toBe(
      'https://w.test/projects/p/artifacts/a',
    );
    expect(artifactWebUrl('', 'https://w.test', 'p', 'a')).toBe(
      'https://w.test/projects/p/artifacts/a',
    );
  });
});

describe('list helpers', () => {
  test('pinned rows come first and keep their relative order', () => {
    const rows = [row({ id: '1' }), row({ id: '2', pinned: true }), row({ id: '3' })];
    expect(orderRows(rows).map((r) => r.id)).toEqual(['2', '1', '3']);
  });

  test('the filter matches title, path or author, ignoring case', () => {
    const rows = [row({ id: '1' }), row({ id: '2', title: 'Deck', path: '/workspace/deck', author: 'Lin' })];
    expect(filterArtifactRows(rows, 'PLAN').map((r) => r.id)).toEqual(['1']);
    expect(filterArtifactRows(rows, 'deck').map((r) => r.id)).toEqual(['2']);
    expect(filterArtifactRows(rows, 'lin').map((r) => r.id)).toEqual(['2']);
    expect(filterArtifactRows(rows, '')).toHaveLength(2);
  });
});

describe('unavailableReason', () => {
  test('names the missing project, then the off flag, and is null otherwise', () => {
    expect(unavailableReason({ projectId: null, flagLoading: false, flagEnabled: false })).toContain(
      'No project selected',
    );
    expect(unavailableReason({ projectId: 'p', flagLoading: false, flagEnabled: false })).toContain(
      '`artifacts` flag',
    );
    expect(unavailableReason({ projectId: 'p', flagLoading: true, flagEnabled: false })).toBeNull();
    expect(unavailableReason({ projectId: 'p', flagLoading: false, flagEnabled: true })).toBeNull();
  });
});
