/** A session token on /v1/drives acts as the person who started the session, only in their private session. */
import { describe, expect, test } from 'bun:test';
import { type SessionFacts, sessionFilesRefusal } from './service';

const ANA = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const own: SessionFacts = { createdBy: ANA, visibility: 'private', origin: 'user', agentName: 'kortix', metadata: null };

describe('sessionFilesRefusal', () => {
  test('her own private session uses Files as her', () => {
    expect(sessionFilesRefusal(own, ANA)).toBeNull();
  });

  // A move or delete there could change who reaches a folder, so no call at all.
  test('a shared, Slack or scheduled session she started is refused', () => {
    expect(sessionFilesRefusal({ ...own, visibility: 'project' }, ANA)).toContain('private session');
    expect(sessionFilesRefusal({ ...own, metadata: { source: 'slack' } }, ANA)).toContain('private session');
    expect(sessionFilesRefusal({ ...own, origin: 'schedule' }, ANA)).toContain('private session');
  });

  test('a token for someone else, a session nobody started, or no session is refused', () => {
    expect(sessionFilesRefusal(own, BOB)).toContain('person started');
    expect(sessionFilesRefusal({ ...own, createdBy: null, origin: 'trigger' }, ANA)).toContain('person started');
    expect(sessionFilesRefusal(null, ANA)).toContain('person started');
  });
});
