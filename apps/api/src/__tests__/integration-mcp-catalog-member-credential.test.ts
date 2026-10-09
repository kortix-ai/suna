/**
 * Which credential an MCP connector's tool list is fetched with
 * (`resolveMcpCatalogCredential`). Holds for every MCP connector, not one app.
 *
 * Found live: an MCP app installed "Only you" signed in through OAuth, but the
 * tool list stayed `MCP tools/list failed: HTTP 401` with zero tools, because
 * only a project account could publish the shared catalog and the project
 * account never signed in. Decision 2026-10-09: with no project credential, the
 * earliest signed-in member account loads the catalog.
 *
 * Real-Postgres contract: runs in the db-suites lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  connectionCredentials,
  connectorConnections,
  connectors,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveFirstMemberCredential } from '../connectors/credentials';
import { resolveMcpCatalogCredential } from '../connectors/sync';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
// Signed in only by members: one revoked, two active (A first, then B).
const MEMBER_ONLY = crypto.randomUUID();
const REVOKED = crypto.randomUUID();
const MEMBER_A = crypto.randomUUID();
const MEMBER_B = crypto.randomUUID();
// A project account with a credential plus a member account: the project wins.
const WITH_PROJECT = crypto.randomUUID();
const PROJECT_CONN = crypto.randomUUID();
const MEMBER_C = crypto.randomUUID();
// Nobody signed in: an unsigned project account only.
const UNSIGNED = crypto.randomUUID();
const UNSIGNED_CONN = crypto.randomUUID();

const mcp = (connectorId: string, slug: string) => ({
  connectorId,
  accountId: ACCOUNT,
  projectId: PROJECT,
  slug,
  name: slug,
  providerType: 'mcp' as const,
  config: { url: `https://${slug}.example.test/mcp` },
  status: 'error' as const,
  lastError: 'MCP tools/list failed: HTTP 401',
});

const connection = (
  connectionId: string,
  connectorId: string,
  ownerType: 'project' | 'member',
  status: 'active' | 'revoked' = 'active',
) => ({
  connectionId,
  accountId: ACCOUNT,
  projectId: PROJECT,
  connectorId,
  ownerType,
  ownerId: ownerType === 'project' ? null : crypto.randomUUID(),
  status,
  label: connectionId.slice(0, 8),
});

const credential = (connectorId: string, connectionId: string, value: string, at: string) => ({
  connectorId,
  connectionId,
  valueEnc: encryptProjectSecret(PROJECT, value),
  createdAt: new Date(at),
});

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'mcp-member-catalog-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'mcp-member-catalog-test',
    repoUrl: 'https://example.test/mcp-member-catalog.git',
  });
  await db
    .insert(connectors)
    .values([
      mcp(MEMBER_ONLY, 'member-only'),
      mcp(WITH_PROJECT, 'with-project'),
      mcp(UNSIGNED, 'unsigned'),
    ]);
  await db
    .insert(connectorConnections)
    .values([
      connection(REVOKED, MEMBER_ONLY, 'member', 'revoked'),
      connection(MEMBER_A, MEMBER_ONLY, 'member'),
      connection(MEMBER_B, MEMBER_ONLY, 'member'),
      connection(PROJECT_CONN, WITH_PROJECT, 'project'),
      connection(MEMBER_C, WITH_PROJECT, 'member'),
      connection(UNSIGNED_CONN, UNSIGNED, 'project'),
    ]);
  await db
    .insert(connectionCredentials)
    .values([
      credential(MEMBER_ONLY, REVOKED, 'revoked-token', '2026-10-01T00:00:00Z'),
      credential(MEMBER_ONLY, MEMBER_A, 'member-a-token', '2026-10-02T00:00:00Z'),
      credential(MEMBER_ONLY, MEMBER_B, 'member-b-token', '2026-10-03T00:00:00Z'),
      credential(WITH_PROJECT, MEMBER_C, 'member-c-token', '2026-10-01T00:00:00Z'),
      credential(WITH_PROJECT, PROJECT_CONN, 'project-token', '2026-10-02T00:00:00Z'),
    ]);
});

afterAll(async () => {
  await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, MEMBER_ONLY));
  await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, WITH_PROJECT));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('MCP catalog credential', () => {
  test('signed in only by members: the earliest ACTIVE member account loads the tools', async () => {
    expect(await resolveFirstMemberCredential(MEMBER_ONLY)).toBe('member-a-token');
    expect(await resolveMcpCatalogCredential(MEMBER_ONLY, undefined)).toEqual({
      value: 'member-a-token',
      member: true,
    });
  });

  test('a signed-in project account wins over any member account', async () => {
    expect(await resolveMcpCatalogCredential(WITH_PROJECT, undefined)).toEqual({
      value: 'project-token',
      member: false,
    });
  });

  test('nobody signed in: no credential, so the catalog stays unauthorized', async () => {
    expect(await resolveMcpCatalogCredential(UNSIGNED, undefined)).toEqual({
      value: null,
      member: false,
    });
  });
});
