/**
 * Integration test (real local DB): the SQL behind human messaging.
 *
 *  - resolveSessionParticipants: emails -> account members who may run sessions
 *  - sessionMayMessage: the two cases where an agent messages a session it
 *    cannot otherwise see (its parent, a session that messaged it first)
 *  - sessionMessageSender: the header's speaker, from the credential
 *  - sessionMessageAuthors: who wrote each message, read from the prompt ledger
 *  - the `participant=me` list filter (`metadata.participants @> [viewer]`)
 *
 * Every row is synthetic. Product flows: SESS-41, SESS-42.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { loadProjectSessionInventory, type SessionListFilter } from '../projects/lib/session-list';
import { sessionMessageAuthors } from '../projects/lib/session-message-authors';
import {
  MAX_SESSION_PARTICIPANTS,
  resolveSessionParticipants,
  sessionMayMessage,
  sessionMessageSender,
} from '../projects/lib/session-participants';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const tag = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const AVERY = crypto.randomUUID(); // project member, full_name set
const BLAKE = crypto.randomUUID(); // project member, no name
const NO_ROLE = crypto.randomUUID(); // account member, no project role
const STRANGER = crypto.randomUUID(); // auth user, not in the account
const email = (label: string) => `${label}-${tag}@example.test`;
const sid = (id: string) => `${id}-${tag}`;

async function session(input: {
  id: string;
  parent?: string;
  projectId?: string;
  createdBy?: string;
  visibility?: 'project' | 'private';
  metadata?: Record<string, unknown>;
  minutesAgo?: number;
}) {
  const at = new Date(Date.now() - (input.minutesAgo ?? 1) * 60_000);
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: input.projectId ?? PROJECT,
    branchName: sid(input.id),
    createdBy: input.createdBy ?? OWNER,
    visibility: input.visibility ?? 'project',
    parentSessionId: input.parent ? sid(input.parent) : null,
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: at,
  });
}

let commandN = 0;
async function prompt(input: {
  to: string;
  actor?: string | null;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
}) {
  commandN += 1;
  await db.insert(sessionLifecycleCommands).values({
    commandType: 'continue_session',
    source: 'ui',
    projectId: PROJECT,
    accountId: ACCOUNT,
    sessionId: sid(input.to),
    actorUserId: input.actor === undefined ? OWNER : input.actor,
    idempotencyKey: `hm-${tag}-${commandN}`,
    payload: input.payload,
    result: input.result ?? {},
  });
}

beforeAll(async () => {
  const user = (id: string, label: string, meta: Record<string, unknown> = {}) =>
    sql`(${id}::uuid, ${email(label)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify(meta)}::jsonb)`;
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data) values
      ${user(OWNER, 'owner')}, ${user(AVERY, 'avery', { full_name: 'Avery Example' })},
      ${user(BLAKE, 'blake')}, ${user(NO_ROLE, 'norole')}, ${user(STRANGER, 'stranger')}
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `human-messaging-${tag}` });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner' });
  for (const userId of [AVERY, BLAKE, NO_ROLE]) {
    await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
  }
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' },
    { projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'q', repoUrl: 'https://example.com/q.git' },
  ]);
  for (const userId of [AVERY, BLAKE]) {
    await insertIntoView(db, projectMembers, {
      accountId: ACCOUNT, projectId: PROJECT, userId, projectRole: 'member', grantedBy: OWNER,
    });
  }
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions, commands, members
  await db.execute(sql`delete from auth.users where id in
    (${OWNER}::uuid, ${AVERY}::uuid, ${BLAKE}::uuid, ${NO_ROLE}::uuid, ${STRANGER}::uuid)`);
});

describe('resolveSessionParticipants', () => {
  const resolve = (raw: unknown) => resolveSessionParticipants(ACCOUNT, PROJECT, raw);

  test('emails match case-insensitively, duplicates collapse, name falls back to the email', async () => {
    const result = await resolve([email('avery').toUpperCase(), email('avery'), ` ${email('blake')} `]);
    expect(result).toEqual({
      people: [
        { userId: AVERY, email: email('avery'), name: 'Avery Example' },
        { userId: BLAKE, email: email('blake'), name: email('blake') },
      ],
    });
  });

  test('one address as a bare string is accepted; the account owner may be asked', async () => {
    expect(await resolve(email('owner'))).toEqual({
      people: [{ userId: OWNER, email: email('owner'), name: email('owner') }],
    });
  });

  test('a user outside the account, a member without a project role, and an unknown address are all 404 and all named', async () => {
    const result = await resolve([email('avery'), email('stranger'), email('norole'), email('ghost')]);
    expect(result).toMatchObject({ status: 404, code: 'PARTICIPANT_NOT_FOUND' });
    const { error } = result as { error: string };
    for (const who of ['stranger', 'norole', 'ghost']) expect(error).toContain(email(who));
    expect(error).not.toContain(email('avery'));
  });

  test('an empty list, more than the maximum, a non-email and a non-array are 400', async () => {
    const tooMany = Array.from({ length: MAX_SESSION_PARTICIPANTS + 1 }, (_, i) => `p${i}@example.test`);
    for (const raw of [[], tooMany, ['no-at-sign'], ['a b@example.test'], [''], [42], undefined, {}]) {
      expect(await resolve(raw)).toMatchObject({ status: 400, code: 'INVALID_PARTICIPANTS' });
    }
  });

  test('an address with SQL or array-literal characters is refused before it reaches the query', async () => {
    for (const raw of [['a"b@example.test'], ['a,b@example.test'], ['a{b}@example.test'], [`a\\b@example.test`]]) {
      expect(await resolve(raw)).toMatchObject({ status: 400, code: 'INVALID_PARTICIPANTS' });
    }
  });
});

describe('sessionMayMessage', () => {
  beforeAll(async () => {
    await session({ id: 'coordinator', visibility: 'private' });
    await session({ id: 'worker', parent: 'coordinator', visibility: 'private' });
    await session({ id: 'asker', visibility: 'private' });
    await session({ id: 'ask', parent: 'asker', visibility: 'private' });
    await session({ id: 'stranger-a', visibility: 'private' });
    await session({ id: 'foreign', projectId: OTHER_PROJECT, visibility: 'private' });
    // `ask` was messaged by `asker` first: a reply is allowed.
    await prompt({ to: 'ask', payload: { authorSessionId: sid('asker'), clientMessageId: 'c1' } });
    // `stranger-a` messaged `worker`: only `worker` may reply to it, not the reverse.
    await prompt({ to: 'worker', payload: { authorSessionId: sid('stranger-a'), clientMessageId: 'c2' } });
  });
  const may = (from: string, to: string, projectId = PROJECT) =>
    sessionMayMessage(sid(from), sid(to), projectId).then((row) => row?.sessionId ?? null);

  test('a session may message its parent, although the parent is private', async () => {
    expect(await may('worker', 'coordinator')).toBe(sid('coordinator'));
  });

  test('a session may reply to a session that messaged it', async () => {
    expect(await may('worker', 'stranger-a')).toBe(sid('stranger-a'));
  });

  test('a session may not message its child or an unrelated session', async () => {
    expect(await may('coordinator', 'worker')).toBeNull();
    expect(await may('stranger-a', 'asker')).toBeNull();
    expect(await may('ask', 'stranger-a')).toBeNull();
  });

  test('a session may not message itself away from the project: cross-project and unknown ids are refused', async () => {
    expect(await may('worker', 'foreign')).toBeNull();
    expect(await may('worker', 'coordinator', OTHER_PROJECT)).toBeNull();
    expect(await may('no-such-session', 'coordinator')).toBeNull();
  });
});

describe('sessionMessageAuthors', () => {
  const authorsOf = async (id: string) => {
    const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sid(id)));
    return sessionMessageAuthors(row!);
  };

  beforeAll(async () => {
    await session({ id: 'lead', metadata: { name: 'Lead session' } });
    await session({ id: 'spawned', parent: 'lead', metadata: { name: 'Spawned', initial_prompt: 'go' } });
    await session({ id: 'spawned-no-prompt', parent: 'lead', metadata: { name: 'No prompt' } });
    await session({ id: 'chat' });
    await session({ id: 'sender', metadata: { custom_name: 'Custom title', name: 'Auto title' } });
    await prompt({ to: 'chat', actor: AVERY, payload: { clientMessageId: 'a', wireMessageId: 'msg_wire_a' } });
    await prompt({
      to: 'chat',
      actor: BLAKE,
      payload: {
        clientMessageId: 'b',
        wireMessageId: 'msg_wire_b',
        redeliveredMessageId: 'msg_redelivered_b',
        redeliveredMessageIds: ['msg_redelivered_b2', 7],
      },
      result: { forwarded_message_id: 'msg_forwarded_b' },
    });
    // From another session's agent: attributed to that session, not to the actor.
    await prompt({
      to: 'chat',
      actor: OWNER,
      payload: { clientMessageId: 'c', wireMessageId: 'msg_wire_c', authorSessionId: sid('sender') },
    });
    // No clientMessageId (trigger, reminder, channel relay): ignored.
    await prompt({ to: 'chat', actor: OWNER, payload: { wireMessageId: 'msg_wire_relay' } });
    // A user that no longer exists, and a session outside the project: no author.
    await prompt({ to: 'chat', actor: crypto.randomUUID(), payload: { clientMessageId: 'd', wireMessageId: 'msg_wire_gone' } });
    await prompt({ to: 'chat', actor: OWNER, payload: { clientMessageId: 'e', wireMessageId: 'msg_wire_foreign', authorSessionId: sid('foreign') } });
  });

  test('a member is attributed under every id the prompt travelled under', async () => {
    const { authors } = await authorsOf('chat');
    const avery = { kind: 'member' as const, user_id: AVERY, name: 'Avery Example', email: email('avery') };
    const blake = { kind: 'member' as const, user_id: BLAKE, name: email('blake'), email: email('blake') };
    expect(authors.msg_wire_a).toEqual(avery);
    for (const id of ['msg_wire_b', 'msg_redelivered_b', 'msg_redelivered_b2', 'msg_forwarded_b']) {
      expect(authors[id]).toEqual(blake);
    }
  });

  test('a prompt sent by another session names that session, using its custom title first', async () => {
    const { authors } = await authorsOf('chat');
    expect(authors.msg_wire_c).toEqual({ kind: 'session' as const, session_id: sid('sender'), name: 'Custom title' });
  });

  test('rows without a clientMessageId, a deleted user, and a session of another project carry no author', async () => {
    const { authors } = await authorsOf('chat');
    expect(Object.keys(authors).sort()).toEqual(
      ['msg_forwarded_b', 'msg_redelivered_b', 'msg_redelivered_b2', 'msg_wire_a', 'msg_wire_b', 'msg_wire_c'],
    );
  });

  test('initial_author is the parent session only for a spawned session that carries an initial_prompt', async () => {
    expect((await authorsOf('spawned')).initial_author).toEqual({ kind: 'session' as const, session_id: sid('lead'), name: 'Lead session' });
    expect((await authorsOf('spawned-no-prompt')).initial_author).toBeNull();
    expect((await authorsOf('lead')).initial_author).toBeNull();
    expect((await authorsOf('lead')).authors).toEqual({});
  });
});

describe('participant=me list filter', () => {
  const list = (filter: SessionListFilter, userId = AVERY) =>
    loadProjectSessionInventory({
      projectId: PROJECT,
      accountId: ACCOUNT,
      userId,
      effectiveRole: 'write' as never,
      scope: 'visible',
      boundCredentialSessionId: null,
      probeManageCapability: async () => false,
      limit: 50,
      cursor: null,
      filter,
    });
  const ids = (items: { row: { sessionId: string } }[]) =>
    items.map((item) => item.row.sessionId.replace(`-${tag}`, '')).sort();

  beforeAll(async () => {
    // Project-visible rows isolate the SQL predicate from the grant check.
    await session({ id: 'pm-ask-avery', metadata: { participants: [AVERY], awaiting_reply: true } });
    await session({ id: 'pm-group', metadata: { participants: [BLAKE, AVERY], awaiting_reply: false } });
    await session({ id: 'pm-blake-only', metadata: { participants: [BLAKE] } });
    await session({ id: 'pm-plain' });
    await session({ id: 'pm-nested-parent' });
    await session({ id: 'pm-nested', parent: 'pm-nested-parent', metadata: { participants: [AVERY] } });
    await session({ id: 'pm-deleted', metadata: { participants: [AVERY], deletedAt: new Date().toISOString() } });
    // Restricted without a grant for the viewer: the list never shows it, filter or not.
    await session({ id: 'pm-restricted-nogrant', visibility: 'private', createdBy: OWNER, metadata: { participants: [AVERY] } });
  });

  test('returns every conversation the viewer was asked into, at any depth, and nothing else', async () => {
    const { items } = await list({ participant: 'me' });
    expect(ids(items)).toEqual(['pm-ask-avery', 'pm-group', 'pm-nested']);
  });

  test('is per viewer', async () => {
    expect(ids((await list({ participant: 'me' }, BLAKE)).items)).toEqual(['pm-blake-only', 'pm-group']);
    expect(ids((await list({ participant: 'me' }, NO_ROLE)).items)).toEqual([]);
  });

  test('does not append the spawn-chain ancestors that the tree view adds', async () => {
    const { items } = await list({ participant: 'me' });
    expect(ids(items)).not.toContain('pm-nested-parent');
  });

  test('without the filter the same viewer sees the unasked sessions too', async () => {
    expect(ids((await list({})).items)).toEqual(expect.arrayContaining(['pm-plain', 'pm-blake-only']));
  });
});

describe('sessionMessageSender', () => {
  beforeAll(async () => {
    await session({ id: 'titled', metadata: { custom_name: 'Renamed', name: 'Auto' } });
    await session({ id: 'untitled' });
  });

  test('a session credential speaks as that session, custom title first, else the auto name, else Untitled', async () => {
    expect(await sessionMessageSender(OWNER, sid('titled'), PROJECT)).toEqual({ kind: 'session' as const, sessionId: sid('titled'), title: 'Renamed' });
    expect(await sessionMessageSender(OWNER, sid('untitled'), PROJECT)).toEqual({ kind: 'session' as const, sessionId: sid('untitled'), title: 'Untitled session' });
  });

  test('a session of another project is never read: the title falls back', async () => {
    expect(await sessionMessageSender(OWNER, sid('titled'), OTHER_PROJECT)).toEqual({ kind: 'session' as const, sessionId: sid('titled'), title: 'Untitled session' });
  });

  test('without a session credential the person speaks: display name, else the email', async () => {
    expect(await sessionMessageSender(AVERY, null, PROJECT)).toEqual({ kind: 'person', name: 'Avery Example', email: email('avery') });
    expect(await sessionMessageSender(BLAKE, null, PROJECT)).toEqual({ kind: 'person', name: email('blake'), email: email('blake') });
  });
});
