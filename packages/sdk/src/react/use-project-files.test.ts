import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import {
  driveConflictsQueryOptions,
  driveFolderQueryOptions,
  folderAccessQueryOptions,
  folderPrincipalsQueryOptions,
  projectDriveQueryOptions,
  sessionDrivesQueryOptions,
} from './use-project-files';

const D = '11111111-2222-4333-8444-555555555555';

describe('project Files queries', () => {
  test('the project drive is keyed by user and waits for one', () => {
    expect(projectDriveQueryOptions('p1', 'u1').queryKey).toEqual(qk.drives.list('u1', { projectId: 'p1' }));
    expect(projectDriveQueryOptions('p1', 'u1').enabled).toBe(true);
    expect(projectDriveQueryOptions('p1', null).enabled).toBe(false);
    expect(projectDriveQueryOptions('p1', 'u1', false).enabled).toBe(false);
  });

  test('every Files query sits under the drives scope, so one write refreshes them all', () => {
    const scope = qk.drives.scope();
    for (const options of [
      projectDriveQueryOptions('p1', 'u1'),
      driveFolderQueryOptions(D, '/a'),
      folderAccessQueryOptions(D, '/a'),
      folderPrincipalsQueryOptions(D),
      driveConflictsQueryOptions(D),
      sessionDrivesQueryOptions('p1', 's1', true),
    ]) {
      expect(options.queryKey.slice(0, scope.length)).toEqual([...scope]);
    }
  });

  test('nothing is fetched without the ids it needs, or with the session flag off', () => {
    expect(driveFolderQueryOptions(null, '/').enabled).toBe(false);
    expect(folderAccessQueryOptions(D, '/a', false).enabled).toBe(false);
    expect(sessionDrivesQueryOptions('p1', 's1', false).enabled).toBe(false);
    expect(sessionDrivesQueryOptions('p1', undefined, true).enabled).toBe(false);
  });
});
