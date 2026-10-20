import { describe, expect, test } from 'bun:test';
import { tagSessionCreate, tagSessionPatch } from '../../convex/tags';

const who = { orgId: 'org_b', userId: 'user_b' };

describe('session create tagging: Lumen ids are the source of truth', () => {
  test('the Lumen tags come first and carry the caller', () => {
    const out = tagSessionCreate({ name: 'Q3 model', labels: ['quarterly'] }, who, 'ws_b');
    expect(out.labels).toEqual(['lumen-user:user_b', 'lumen-workspace:ws_b', 'quarterly']);
    expect(out.metadata).toEqual({ lumen_org_id: 'org_b', lumen_workspace_id: 'ws_b', lumen_user_id: 'user_b' });
    expect(out.name).toBe('Q3 model');
  });

  test("a client cannot forge another user's or workspace's label", () => {
    const out = tagSessionCreate({ labels: ['lumen-user:user_a', 'LUMEN-workspace:ws_a', 'ok'] }, who, 'ws_b');
    expect(out.labels).toEqual(['lumen-user:user_b', 'lumen-workspace:ws_b', 'ok']);
  });

  test('20 client labels cannot push the Lumen tags out', () => {
    const labels = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const out = tagSessionCreate({ labels }, who, 'ws_b');
    expect(out.labels).toHaveLength(20);
    expect(out.labels.slice(0, 2)).toEqual(['lumen-user:user_b', 'lumen-workspace:ws_b']);
  });

  test('Lumen metadata keys overwrite the client; other keys and non-string labels are handled', () => {
    const out = tagSessionCreate(
      { labels: ['a', 7, null], metadata: { lumen_user_id: 'user_a', ticket: 'T-1' } },
      who,
      'ws_b',
    );
    expect(out.labels).toEqual(['lumen-user:user_b', 'lumen-workspace:ws_b', 'a']);
    expect(out.metadata).toEqual({ ticket: 'T-1', lumen_org_id: 'org_b', lumen_workspace_id: 'ws_b', lumen_user_id: 'user_b' });
    expect(tagSessionCreate({ metadata: ['x'] }, who, 'ws_b').metadata).toEqual({
      lumen_org_id: 'org_b',
      lumen_workspace_id: 'ws_b',
      lumen_user_id: 'user_b',
    });
  });
});

describe('session PATCH tagging: the create-time attribution cannot change', () => {
  const current = ['lumen-user:user_a', 'lumen-workspace:ws_a', 'old'];

  test('forged lumen- labels are replaced by the current ones; lumen_ metadata keys drop', () => {
    const out = tagSessionPatch(
      {
        labels: ['lumen-user:SOMEONE_ELSE', 'lumen-workspace:ws_b', 'new'],
        metadata: { lumen_org_id: 'forged', LUMEN_user_id: 'forged', lumen_workspace_id: null, ticket: 'T-2' },
      },
      current,
    );
    expect(out.labels).toEqual(['lumen-user:user_a', 'lumen-workspace:ws_a', 'new']);
    expect(out.metadata).toEqual({ ticket: 'T-2' });
  });

  test('an empty label list cannot erase the Lumen labels', () => {
    expect(tagSessionPatch({ labels: [] }, current).labels).toEqual(['lumen-user:user_a', 'lumen-workspace:ws_a']);
  });

  test('a rename passes through untouched', () => {
    expect(tagSessionPatch({ name: 'Renamed' }, current)).toEqual({ name: 'Renamed' });
  });
});
