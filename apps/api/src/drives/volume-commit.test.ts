import { expect, test } from 'bun:test';
import { parseVolumeWriteCommit } from './volume-commit';

test('Files commit metadata preserves the writer commit rather than a later merged head', () => {
  const commit = { commit_id: 'writer-one', outcome: 'merged' as const, head_commit_id: 'unrelated-head' };
  expect(parseVolumeWriteCommit(commit)).toEqual(commit);
  expect(parseVolumeWriteCommit({ ...commit, outcome: 'queued' })?.outcome).toBe('queued');
  expect(parseVolumeWriteCommit({ ...commit, outcome: 'noop' })?.outcome).toBe('noop');
  for (const value of [null, {}, { commit_id: 'invalid space', outcome: 'fast' }, { commit_id: 'one', outcome: 'unknown' }]) {
    expect(parseVolumeWriteCommit(value)).toBeUndefined();
  }
});
