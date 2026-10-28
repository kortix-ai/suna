import { describe, expect, test } from 'bun:test';

import { forgetSessionListPollEtags, peekSessionListPollEtag, storeSessionListPollEtag } from './session-list-poll-memo';

const key = (projectId: string, query = 'group=none') => ['user-1', '', 'jwt', '', '', projectId, query].join('|');

describe('session list poll memo', () => {
  test('forgetting a project drops its memoized pages and keeps every other project', () => {
    storeSessionListPollEtag(key('p-1'), { etag: 'W/"a"', nextCursor: null, accountId: 'acc' });
    storeSessionListPollEtag(key('p-1', 'group=g-1'), { etag: 'W/"b"', nextCursor: null, accountId: 'acc' });
    storeSessionListPollEtag(key('p-2'), { etag: 'W/"c"', nextCursor: null, accountId: 'acc' });
    expect(peekSessionListPollEtag(key('p-1'), 'W/"a"')).not.toBeNull();

    forgetSessionListPollEtags('p-1');

    // The next poll of p-1 computes its page again instead of answering 304.
    expect(peekSessionListPollEtag(key('p-1'), 'W/"a"')).toBeNull();
    expect(peekSessionListPollEtag(key('p-1', 'group=g-1'), 'W/"b"')).toBeNull();
    expect(peekSessionListPollEtag(key('p-2'), 'W/"c"')?.etag).toBe('W/"c"');
  });
});
