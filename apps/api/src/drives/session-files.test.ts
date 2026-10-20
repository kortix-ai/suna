/** A session token on /v1/drives acts as the person who started the session. */
import { describe, expect, test } from 'bun:test';
import { type SessionFacts, sessionFilesRefusal } from './service';

const ANA = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const own: SessionFacts = { createdBy: ANA, visibility: 'private', origin: 'user', agentName: 'kortix', metadata: null };

describe('sessionFilesRefusal', () => {
  test('her own private session reads, writes and shares as her', () => {
    expect(sessionFilesRefusal(own, ANA, false)).toBeNull();
    expect(sessionFilesRefusal(own, ANA, true)).toBeNull();
  });

  test('a shared session she started reads and writes but cannot share', () => {
    const shared = { ...own, visibility: 'project' };
    expect(sessionFilesRefusal(shared, ANA, false)).toBeNull();
    expect(sessionFilesRefusal(shared, ANA, true)).toContain('private session');
  });

  test('a Slack session she started cannot share', () => {
    expect(sessionFilesRefusal({ ...own, metadata: { source: 'slack' } }, ANA, true)).toContain('private session');
  });

  test('a token for someone else, an unattended session, or no session is refused', () => {
    expect(sessionFilesRefusal(own, BOB, false)).toContain('person started');
    expect(sessionFilesRefusal({ ...own, createdBy: null, origin: 'trigger' }, ANA, false)).toContain('person started');
    expect(sessionFilesRefusal(null, ANA, false)).toContain('person started');
  });
});
