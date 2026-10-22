import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';

const D = '11111111-2222-4333-8444-555555555555';

describe('qk.drives', () => {
  test('every drive key sits under scope(), so one invalidation reaches all of them', () => {
    const scope = qk.drives.scope();
    for (const key of [
      qk.drives.list('u1', { projectId: 'p1' }),
      qk.drives.drive(D),
      qk.drives.files(D, '/a'),
      qk.drives.versions(D),
      qk.drives.session('p1', 's1'),
    ]) {
      expect(key.slice(0, scope.length)).toEqual([...scope]);
    }
  });

  test("a drive's files and versions sit under drive(id), so a restore invalidates both", () => {
    const drive = qk.drives.drive(D);
    expect(qk.drives.files(D, '/a').slice(0, drive.length)).toEqual([...drive]);
    expect(qk.drives.versions(D).slice(0, drive.length)).toEqual([...drive]);
    expect(qk.drives.grants(D).slice(0, drive.length)).toEqual([...drive]);
    expect(qk.drives.conflicts(D).slice(0, drive.length)).toEqual([...drive]);
  });

  test('lists are partitioned by user and by scope; an unknown user never shares a slot', () => {
    expect(qk.drives.list('u1', { projectId: 'p1' })).not.toEqual(qk.drives.list('u2', { projectId: 'p1' }));
    expect(qk.drives.list('u1', { projectId: 'p1' })).not.toEqual(qk.drives.list('u1', { accountId: 'p1' }));
    expect(qk.drives.list(undefined)).not.toEqual(qk.drives.list('anonymous-user'));
    expect(qk.drives.files(D, '/')).not.toEqual(qk.drives.files(D, '/a'));
  });
});
