import { describe, expect, test } from 'bun:test';
import { decideRewind } from './rewind-authority';
import { clientRevertMessage } from '../../sandbox-proxy/client-abort';
import { decideClientRewind } from '../../sandbox-proxy/forward/abort-authority';

const OWNER = 'owner';
const MEMBER = 'member';
const rows = [
  { ids: ['m1'], sender: OWNER },
  { ids: ['m2', 'm2b'], sender: null }, // an agent session's prompt
  { ids: ['m3'], sender: MEMBER },
];
const decide = (messageId: string, userId: string) =>
  decideRewind({ rows, messageId, userId, sessionCreatedBy: OWNER });

describe('decideRewind: only the sender, and only with no later message by someone else', () => {
  test("a member cannot rewind the owner's message", () => {
    expect(decide('m1', MEMBER)).toBe(false);
  });
  test('the owner cannot rewind their own message once a member replied after it', () => {
    expect(decide('m1', OWNER)).toBe(false);
  });
  test('the member rewinds their own last message', () => {
    expect(decide('m3', MEMBER)).toBe(true);
  });
  test("an agent's message is the thread starter's: the owner may not pass the member's reply, the member may not touch it", () => {
    expect(decide('m2b', MEMBER)).toBe(false);
    expect(decide('m2', OWNER)).toBe(false);
  });
  test('a message the ledger does not hold is the starter’s, and every recorded row counts as later', () => {
    expect(decide('unknown', OWNER)).toBe(false);
    expect(decideRewind({ rows: rows.slice(0, 2), messageId: 'unknown', userId: OWNER, sessionCreatedBy: OWNER })).toBe(true);
    expect(decideRewind({ rows: [], messageId: 'unknown', userId: MEMBER, sessionCreatedBy: OWNER })).toBe(false);
  });
});

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

describe('clientRevertMessage: the proxy recognizes a rewind', () => {
  test('POST /session/:id/revert on the daemon port → the messageID', () => {
    expect(clientRevertMessage(8000, 'POST', '/session/ses_1/revert', body({ messageID: 'm1' }))).toBe('m1');
    expect(clientRevertMessage(8000, 'POST', '/proxy/4096/session/ses_1/revert', body({ messageID: 'm1' }))).toBe('m1');
  });
  test('no messageID → empty, not null: the guard still runs and refuses', () => {
    expect(clientRevertMessage(8000, 'POST', '/session/ses_1/revert', undefined)).toBe('');
  });
  test('other calls are not a rewind', () => {
    expect(clientRevertMessage(8000, 'GET', '/session/ses_1/revert', undefined)).toBeNull();
    expect(clientRevertMessage(8000, 'POST', '/session/ses_1/unrevert', undefined)).toBeNull();
    expect(clientRevertMessage(3000, 'POST', '/session/ses_1/revert', body({ messageID: 'm1' }))).toBeNull();
  });
});

describe('decideClientRewind', () => {
  const person = { kind: 'principal', userId: MEMBER, callerSessionId: null, boundCredentialSessionId: null, sandboxAuthored: false } as any;
  test('a person is asked about by the ledger rule', async () => {
    expect(await decideClientRewind(person, 's', 'm1', async (_s, user, message) => user === MEMBER && message === 'm3')).toBe(false);
    expect(await decideClientRewind(person, 's', 'm3', async (_s, user, message) => user === MEMBER && message === 'm3')).toBe(true);
  });
  test('no message id → refused without a read', async () => {
    expect(await decideClientRewind(person, 's', '', async () => true)).toBe(false);
  });
  test('a share is refused; a session-bound agent credential keeps its access', async () => {
    expect(await decideClientRewind({ kind: 'share' } as any, 's', 'm1', async () => true)).toBe(false);
    expect(await decideClientRewind({ ...person, boundCredentialSessionId: 's' }, 's', 'm1', async () => false)).toBe(true);
  });
});
