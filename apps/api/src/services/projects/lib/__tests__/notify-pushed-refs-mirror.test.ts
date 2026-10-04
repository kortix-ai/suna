/** A push to a session branch drops the local mirror marker; it is not a base move. */
import { describe, expect, mock, test } from 'bun:test';
import * as realMirror from '../../../git/mirror';

const invalidated: string[] = [];
mock.module('../../../git/mirror', () => ({
  ...realMirror,
  invalidateProjectMirror: (id: string) => void invalidated.push(id),
}));

const { notifyPushedRefs } = await import('../config-convergence-triggers');

describe('notifyPushedRefs', () => {
  const sha = 'a'.repeat(40);
  test('a session-branch push invalidates the local mirror once', () => {
    invalidated.length = 0;
    notifyPushedRefs('p1', [{ ref: 'refs/heads/3f2b1c4d-1111-4222-8333-944455556666', newSha: sha }]);
    expect(invalidated).toEqual(['p1']);
  });
  test('a tag push invalidates nothing', () => {
    invalidated.length = 0;
    notifyPushedRefs('p1', [{ ref: 'refs/tags/v1', newSha: sha }]);
    expect(invalidated).toEqual([]);
  });
});
