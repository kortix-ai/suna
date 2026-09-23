/**
 * Real-Postgres contract for the connector identity a Composio authorization
 * lands as, and for the default slot surviving a relabel.
 *
 * A project-shared account authorized with a personal login looked exactly
 * like one authorized with the shared login: its label ("Private
 * connection", or the connector name) was chosen before authorization. The
 * finalize path now records `metadata.connected_as` and replaces a generic
 * default label with that identity. The `ensure*Connection` lookups used to
 * find their row by that default label only, so a relabel would have made
 * the next connect create a duplicate row. This file proves it does not.
 *
 * Composio itself is a fake runtime (`setComposioRuntimeForTest`). The API
 * route handlers, the connection rows, and the SQL are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import {
  setComposioRuntimeForTest,
  type ComposioRuntime,
  type ComposioSessionLike,
} from '../connectors/composio';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const PROJECT_CONNECTOR = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OTHER_MEMBER = crypto.randomUUID();

/** Fake Composio state: which stable users hold an active account, and who it is. */
const active = new Map<string, { accountId: string; displayName: string | null }>();
let pendingAuthorization: { stableUserId: string; accountId: string; displayName: string | null } | null =
  null;
let probes = 0;
let previousKey: string | undefined;

function fakeSession(stableUserId: string, sessionId: string, toolkit: string): ComposioSessionLike {
  return {
    sessionId,
    async tools() {
      return [];
    },
    async toolkits() {
      const account = active.get(stableUserId);
      return {
        items: [
          {
            slug: toolkit,
            name: toolkit,
            isNoAuth: false,
            ...(account
              ? { connection: { isActive: true, connectedAccount: { id: account.accountId, status: 'ACTIVE' } } }
              : {}),
          },
        ],
        cursor: undefined,
        totalPages: 1,
      } as any;
    },
    async authorize() {
      return {
        id: `auth-${sessionId}`,
        status: 'INITIATED',
        redirectUrl: 'https://composio.test/connect',
        toJSON: () => ({ id: `auth-${sessionId}`, status: 'INITIATED', redirectUrl: 'https://composio.test/connect' }),
      } as any;
    },
    async execute() {
      throw new Error('no whoami tool in this fake');
    },
  };
}

const sessionsById = new Map<string, { stableUserId: string; toolkit: string }>();
const fakeRuntime: ComposioRuntime = {
  sessions: {
    async create(userId, config) {
      const sessionId = `trs_${crypto.randomUUID()}`;
      const toolkit = (config as any)?.toolkits?.[0] ?? 'gmail';
      sessionsById.set(sessionId, { stableUserId: userId, toolkit });
      return fakeSession(userId, sessionId, toolkit);
    },
    async use(sessionId) {
      const known = sessionsById.get(sessionId)!;
      // Finalize resumes the session after the human finished the hosted
      // page, so that is when the pending account becomes active.
      if (pendingAuthorization?.stableUserId === known.stableUserId) {
        active.set(pendingAuthorization.stableUserId, {
          accountId: pendingAuthorization.accountId,
          displayName: pendingAuthorization.displayName,
        });
        pendingAuthorization = null;
      }
      return fakeSession(known.stableUserId, sessionId, known.toolkit);
    },
  },
  connectedAccounts: {
    async get(id: string) {
      probes += 1;
      const account = [...active.values()].find((candidate) => candidate.accountId === id);
      return { state: { val: account?.displayName ? { displayName: account.displayName } : {} } };
    },
  },
};

async function rowsOf(connectorId: string) {
  return db
    .select({
      connectionId: connectorConnections.connectionId,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      label: connectorConnections.label,
      metadata: connectorConnections.metadata,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectorId, connectorId));
}

async function connectAndFinish(input: {
  slug: string;
  owner: 'me' | 'project';
  userId: string;
  accountId: string;
  displayName: string | null;
}) {
  const started = await dbConnectorRouterDeps.connectorConnect!(
    PROJECT,
    input.slug,
    input.userId,
    undefined,
    null,
    input.owner,
  );
  expect(started).not.toBeNull();
  const stableUserId = `kortix-connection:${started!.connectionId}`;
  if (!active.has(stableUserId)) {
    pendingAuthorization = { stableUserId, accountId: input.accountId, displayName: input.displayName };
  }
  return started!;
}

beforeAll(async () => {
  previousKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY ||= 'test-composio-key';
  setComposioRuntimeForTest(fakeRuntime);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connected-as-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connected-as-test',
    repoUrl: 'https://example.test/connected-as.git',
  });
  await db.insert(connectors).values([
    {
      connectorId: CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'gmail',
      name: 'Gmail',
      providerType: 'composio',
      config: { app: 'gmail' },
    },
    {
      connectorId: PROJECT_CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'linear',
      name: 'Linear',
      providerType: 'composio',
      config: { app: 'linear' },
    },
  ]);
});

beforeEach(() => {
  pendingAuthorization = null;
  probes = 0;
});

afterAll(async () => {
  setComposioRuntimeForTest(null);
  if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = previousKey;
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('member connection authorized through Composio', () => {
  test('finalize records the identity and replaces the generic default label with it', async () => {
    const started = await connectAndFinish({
      slug: 'gmail',
      owner: 'me',
      userId: MEMBER,
      accountId: 'ca_member_1',
      displayName: 'Ops@Example.test',
    });
    expect(started.connectUrl).toBe('https://composio.test/connect');

    const finalized = await dbConnectorRouterDeps.connectorFinalize!(PROJECT, 'gmail', MEMBER, undefined, 'me');
    expect(finalized).toMatchObject({
      connected: true,
      connectionId: started.connectionId,
      connectedAs: 'ops@example.test',
      label: 'ops@example.test',
    });

    const [row] = await rowsOf(CONNECTOR);
    expect(row!.label).toBe('ops@example.test');
    expect(row!.metadata).toMatchObject({
      provider: 'composio',
      connected_account_id: 'ca_member_1',
      connected_as: 'ops@example.test',
      default_slot: 'member',
      connector_slug: 'gmail',
    });
  });

  test('a repeated finalize reuses the stored identity instead of calling the provider again', async () => {
    const finalized = await dbConnectorRouterDeps.connectorFinalize!(PROJECT, 'gmail', MEMBER, undefined, 'me');
    expect(finalized).toMatchObject({ connected: true, connectedAs: 'ops@example.test' });
    expect(probes).toBe(0);
  });

  test('connecting again after the relabel reuses the same row, never a duplicate', async () => {
    const [before] = await rowsOf(CONNECTOR);
    const started = await dbConnectorRouterDeps.connectorConnect!(PROJECT, 'gmail', MEMBER, undefined, null, 'me');
    expect(started!.connectionId).toBe(before!.connectionId);
    // The entity already holds an active account: start reuses it (no url),
    // and the identity it was authorized as is kept.
    expect(started!.connectUrl).toBeUndefined();
    expect(started!.connected).toBe(true);
    const rows = await rowsOf(CONNECTOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ connected_as: 'ops@example.test', default_slot: 'member' });
  });

  test('a label a person chose is never overwritten by the identity', async () => {
    const [row] = await rowsOf(CONNECTOR);
    await db
      .update(connectorConnections)
      .set({ label: 'Support inbox' })
      .where(eq(connectorConnections.connectionId, row!.connectionId));
    // Force a fresh probe: pretend the stored identity predates this account.
    await db
      .update(connectorConnections)
      .set({ metadata: { ...(row!.metadata as object), connected_as: null } })
      .where(eq(connectorConnections.connectionId, row!.connectionId));

    const finalized = await dbConnectorRouterDeps.connectorFinalize!(PROJECT, 'gmail', MEMBER, undefined, 'me');
    expect(finalized).toMatchObject({ connectedAs: 'ops@example.test', label: 'Support inbox' });
    const [after] = await rowsOf(CONNECTOR);
    expect(after!.label).toBe('Support inbox');
    expect(after!.metadata).toMatchObject({ connected_as: 'ops@example.test' });
  });

  test('a renamed default row is still the slot a label-less connect reuses', async () => {
    const started = await dbConnectorRouterDeps.connectorConnect!(PROJECT, 'gmail', MEMBER, undefined, null, 'me');
    const rows = await rowsOf(CONNECTOR);
    expect(rows).toHaveLength(1);
    expect(started!.connectionId).toBe(rows[0]!.connectionId);
  });

  test('an identity another row of the same owner already carries keeps the default label', async () => {
    // A second member's default row, plus a row of theirs that already
    // carries the identity label. The unique index refuses the relabel, and
    // finalize still succeeds with the identity recorded.
    await db.insert(connectorConnections).values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'member',
      ownerId: OTHER_MEMBER,
      label: 'dup@example.test',
      status: 'active',
      isDefault: false,
      metadata: {},
    });
    await connectAndFinish({
      slug: 'gmail',
      owner: 'me',
      userId: OTHER_MEMBER,
      accountId: 'ca_other_1',
      displayName: 'dup@example.test',
    });
    const finalized = await dbConnectorRouterDeps.connectorFinalize!(
      PROJECT,
      'gmail',
      OTHER_MEMBER,
      undefined,
      'me',
    );
    expect(finalized).toMatchObject({
      connected: true,
      connectedAs: 'dup@example.test',
      label: 'Private connection',
    });
    const [slot] = await db
      .select({ label: connectorConnections.label, metadata: connectorConnections.metadata })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.connectorId, CONNECTOR),
          eq(connectorConnections.ownerId, OTHER_MEMBER),
          eq(connectorConnections.label, 'Private connection'),
        ),
      );
    expect(slot!.metadata).toMatchObject({ connected_as: 'dup@example.test' });
  });
});

describe('project-shared connection authorized through Composio', () => {
  test('the shared row is labelled with the identity it was authorized as', async () => {
    const started = await connectAndFinish({
      slug: 'linear',
      owner: 'project',
      userId: MEMBER,
      accountId: 'ca_project_1',
      displayName: 'agent@example.test',
    });
    const finalized = await dbConnectorRouterDeps.connectorFinalize!(
      PROJECT,
      'linear',
      MEMBER,
      undefined,
      'project',
    );
    expect(finalized).toMatchObject({
      connected: true,
      connectionId: started.connectionId,
      connectedAs: 'agent@example.test',
      label: 'agent@example.test',
    });
    const rows = await rowsOf(PROJECT_CONNECTOR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerType: 'project', ownerId: null, label: 'agent@example.test' });
    expect(rows[0]!.metadata).toMatchObject({ default_slot: 'project', connected_as: 'agent@example.test' });
  });

  test('connecting the project slot again reuses the relabelled row', async () => {
    const started = await dbConnectorRouterDeps.connectorConnect!(
      PROJECT,
      'linear',
      MEMBER,
      undefined,
      null,
      'project',
    );
    const rows = await rowsOf(PROJECT_CONNECTOR);
    expect(rows).toHaveLength(1);
    expect(started!.connectionId).toBe(rows[0]!.connectionId);
  });

  test('the accounts list names who each account acts as', async () => {
    const accountsList = await dbConnectorRouterDeps.listConnectorAccounts!({
      projectId: PROJECT,
      slug: 'linear',
      userId: MEMBER,
      sessionId: null,
    });
    expect(accountsList).toEqual([
      expect.objectContaining({
        label: 'agent@example.test',
        owner_type: 'project',
        connected_as: 'agent@example.test',
      }),
    ]);
  });
});
