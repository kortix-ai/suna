import { describe, expect, mock, test } from 'bun:test';
import { runWithContext } from '../lib/request-context';

/**
 * `resolveShareSubject` is request-memoized. Independent helpers re-resolve the
 * same subject several times inside ONE request — the Apps list resolved it 3×
 * (visibility filter, openable set, then the link slugs' visibility re-check),
 * measured on the 2026-10-14/15 request-pool saturation burst (KRTX-2341):
 * every redundant resolution is one more statement on a pool that was already
 * queueing, and one more serial stage holding a connection.
 *
 * The memo must stay REQUEST-scoped: the fresh-read contract on
 * `resolveShareSubject` (a membership added between two connector calls must
 * authorize the second) is about ACROSS requests, and a per-request memo
 * honors it — each request's first resolution is a fresh read. These tests pin
 * that contract: one read per request, a fresh read in the next request, and
 * no caching at all outside a request scope.
 */

const USER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B = 'bbbbbbbb-2222-4222-8222-222222222222';

let subjectReads = 0;
let groupsByUser: Map<string, string[]> = new Map();

const realGroupRead = await import('../iam/group-read');
mock.module('../iam/group-read', () => ({
  ...realGroupRead,
  groupIdsOfUser: async (userId: string) => {
    subjectReads += 1;
    return (groupsByUser.get(userId) ?? []).map((groupId) => ({ groupId }));
  },
}));

const { resolveShareSubject } = await import('./share');

describe('resolveShareSubject request memo', () => {
  test('resolves the subject once per request across repeated resolutions', async () => {
    groupsByUser = new Map([[USER_A, ['g1']]]);
    subjectReads = 0;
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      const first = await resolveShareSubject(USER_A);
      const second = await resolveShareSubject(USER_A);
      const third = await resolveShareSubject(USER_A);
      expect(first).toEqual({ userId: USER_A, groupIds: ['g1'] });
      expect(second).toBe(first); // same request, same resolution
      expect(third).toBe(first);
    });
    expect(subjectReads).toBe(1); // the regression: 3 before the memo
  });

  test('a new request resolves fresh — a membership added between requests is seen', async () => {
    groupsByUser = new Map([[USER_A, []]]);
    subjectReads = 0;
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      expect(await resolveShareSubject(USER_A)).toEqual({ userId: USER_A, groupIds: [] });
    });
    // The write SCIM would have made between the two requests.
    groupsByUser = new Map([[USER_A, ['g9']]]);
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      expect(await resolveShareSubject(USER_A)).toEqual({ userId: USER_A, groupIds: ['g9'] });
    });
    expect(subjectReads).toBe(2); // one fresh read per request, never a cached cross-request answer
  });

  test('keys on the user — two users in one request each resolve', async () => {
    groupsByUser = new Map([
      [USER_A, ['g1']],
      [USER_B, ['g2']],
    ]);
    subjectReads = 0;
    await runWithContext('GET', '/v1/projects/p/apps', async () => {
      expect((await resolveShareSubject(USER_A)).groupIds).toEqual(['g1']);
      expect((await resolveShareSubject(USER_B)).groupIds).toEqual(['g2']);
      await resolveShareSubject(USER_A);
      await resolveShareSubject(USER_B);
    });
    expect(subjectReads).toBe(2);
  });

  test('outside a request scope there is no memo — every call reads', async () => {
    groupsByUser = new Map([[USER_A, ['g1']]]);
    subjectReads = 0;
    await resolveShareSubject(USER_A);
    await resolveShareSubject(USER_A);
    expect(subjectReads).toBe(2);
  });
});
