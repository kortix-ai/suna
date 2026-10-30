import { describe, expect, test } from 'bun:test';
import { tagSessionCreate, tagSessionPatch } from '../../convex/tags';

const who = { orgId: 'org_b', userId: 'user_b', firmId: 'firm_b', matterId: 'mat_b', matterDir: '/drives/firm_b/Matters/mat_b' };
const LUMEN = ['lumen-firm:firm_b', 'lumen-matter:mat_b', 'lumen-user:user_b'];
const META = { lumen_org_id: 'org_b', lumen_firm_id: 'firm_b', lumen_matter_id: 'mat_b', lumen_user_id: 'user_b' };

describe('session create tagging: Lumen ids are the source of truth', () => {
  test('the Lumen tags come first and carry the firm, matter and caller', () => {
    const out = tagSessionCreate({ name: 'Q3 model', labels: ['quarterly'] }, who);
    expect(out.labels).toEqual([...LUMEN, 'quarterly']);
    expect(out.metadata).toEqual(META);
    expect(out.name).toBe('Q3 model');
  });

  test('the matter folder is the one Lumen resolved, never one the client sends', () => {
    const out = tagSessionCreate({ runtime_context: { lumen_matter_dir: '/drives/firm-a/Matters/mat_a' } }, { ...who, matterDir: '/drives/j99xyz' });
    expect(out.runtime_context).toEqual({ lumen_matter_dir: '/drives/j99xyz' });
  });

  test("a client cannot forge another user's, firm's or matter's label", () => {
    const out = tagSessionCreate({ labels: ['lumen-user:user_a', 'LUMEN-matter:mat_a', 'Lumen-firm:f', 'ok'] }, who);
    expect(out.labels).toEqual([...LUMEN, 'ok']);
  });

  test('20 client labels cannot push the Lumen tags out', () => {
    const out = tagSessionCreate({ labels: Array.from({ length: 20 }, (_, i) => `l${i}`) }, who);
    expect(out.labels).toHaveLength(20);
    expect(out.labels.slice(0, 3)).toEqual(LUMEN);
  });

  test('Lumen metadata keys overwrite the client; other keys and non-string labels are handled', () => {
    const out = tagSessionCreate({ labels: ['a', 7, null], metadata: { lumen_user_id: 'user_a', ticket: 'T-1' } }, who);
    expect(out.labels).toEqual([...LUMEN, 'a']);
    expect(out.metadata).toEqual({ ticket: 'T-1', ...META });
    expect(tagSessionCreate({ metadata: ['x'] }, who).metadata).toEqual(META);
  });
});

describe('session PATCH tagging: the create-time attribution cannot change', () => {
  const current = ['lumen-firm:firm_a', 'lumen-matter:mat_a', 'lumen-user:user_a', 'old'];

  test('forged lumen- labels are replaced by the current ones; lumen_ metadata keys drop', () => {
    const out = tagSessionPatch(
      {
        labels: ['lumen-user:SOMEONE_ELSE', 'lumen-matter:mat_b', 'new'],
        metadata: { lumen_org_id: 'forged', LUMEN_user_id: 'forged', lumen_matter_id: null, ticket: 'T-2' },
      },
      current,
    );
    expect(out.labels).toEqual(['lumen-firm:firm_a', 'lumen-matter:mat_a', 'lumen-user:user_a', 'new']);
    expect(out.metadata).toEqual({ ticket: 'T-2' });
  });

  test('an empty label list cannot erase the Lumen labels', () => {
    expect(tagSessionPatch({ labels: [] }, current).labels).toEqual(current.slice(0, 3));
  });

  test('a rename passes through untouched', () => {
    expect(tagSessionPatch({ name: 'Renamed' }, current)).toEqual({ name: 'Renamed' });
  });
});
