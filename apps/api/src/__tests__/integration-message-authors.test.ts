/**
 * Integration test (real local DB): sessionMessageAuthors — who wrote each
 * message of a session, read from the prompt ledger.
 *
 * Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projects,
  sessionLifecycleCommands,
  sessionTurns,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { sessionMessageAuthors } from '../projects/lib/session-message-authors';
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
  agentName?: string;
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
    ...(input.agentName ? { agentName: input.agentName } : {}),
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
      ${user(OWNER, 'owner')}, ${user(AVERY, 'avery', { full_name: 'Avery Example', avatar_url: 'https://img.example.test/avery.png' })},
      ${user(BLAKE, 'blake')}, ${user(NO_ROLE, 'norole')}, ${user(STRANGER, 'stranger')}
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `message-authors-${tag}` });
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
    await session({ id: 'sender', metadata: { custom_name: 'Custom title', name: 'Auto title' }, agentName: 'writer-bot' });
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
    const avery = {
      kind: 'member' as const,
      user_id: AVERY,
      name: 'Avery Example',
      email: email('avery'),
      avatar_url: 'https://img.example.test/avery.png',
    };
    const blake = { kind: 'member' as const, user_id: BLAKE, name: email('blake'), email: email('blake'), avatar_url: null };
    expect(authors.msg_wire_a).toEqual(avery);
    for (const id of ['msg_wire_b', 'msg_redelivered_b', 'msg_redelivered_b2', 'msg_forwarded_b']) {
      expect(authors[id]).toEqual(blake);
    }
  });

  test('a prompt sent by another session names that session, using its custom title first, and its agent', async () => {
    const { authors } = await authorsOf('chat');
    expect(authors.msg_wire_c).toEqual({ kind: 'session' as const, session_id: sid('sender'), name: 'Custom title', agent: 'writer-bot' });
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

  test('once the first turn has a message id, the parent is attributed on that message, not as a guess', async () => {
    await session({ id: 'spawned-turned', parent: 'lead', metadata: { name: 'Turned', initial_prompt: 'go' } });
    await db.insert(sessionTurns).values({
      turnToken: crypto.randomUUID(), sessionId: sid('spawned-turned'), sandboxId: crypto.randomUUID(),
      projectId: PROJECT, accountId: ACCOUNT, messageId: 'msg_initial_turn',
    });
    const result = await authorsOf('spawned-turned');
    expect(result.authors.msg_initial_turn).toEqual({ kind: 'session' as const, session_id: sid('lead'), name: 'Lead session' });
    expect(result.initial_author).toBeNull();
  });
});

