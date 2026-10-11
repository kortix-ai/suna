/**
 * Integration test (real PostgreSQL): a computer unpaired while it is being
 * attached to a project is skipped, never a 500.
 *
 * A flow run found `GET /connectors/projects/:id/catalog` answering 500 (pg
 * 23503): `ensureProjectComputer` read the owner's machine, a concurrent
 * unpair deleted it, and the new account's `tunnel_id` then failed its foreign
 * key. `POST /projects/:id/computers` had the same gap between its lookup and
 * the attach. Each test deletes the machine on a second connection, lets the
 * attach block on that row, then commits the delete (helpers/interleave.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, connectorConnections, tunnelConnections } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PgClient } from './helpers/pg-client';
import { ensureProjectComputer } from '../connectors/sync';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';
import { interleave } from './helpers/interleave';

// The route runs through the real app; the owner's account token is the caller.
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');

const OWNER = crypto.randomUUID();
let project: SeededProject;
let token: string;
let tokenId: string;

beforeAll(async () => {
  project = await seedProject('computer-attach-race');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  const minted = await createAccountToken({
    accountId: project.account_id,
    userId: OWNER,
    projectId: project.project_id,
    name: 'computer-attach-race',
  });
  token = minted.secretKey;
  tokenId = minted.tokenId;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(tunnelConnections).where(eq(tunnelConnections.ownerUserId, OWNER));
  await removeSeeded([project]);
});

/** A machine the owner paired in the project's account. */
async function pairMachine(name: string): Promise<string> {
  const [row] = await db
    .insert(tunnelConnections)
    .values({ accountId: project.account_id, ownerUserId: OWNER, name })
    .returning({ tunnelId: tunnelConnections.tunnelId });
  return row!.tunnelId;
}

const unpair = (tunnelId: string) => (tx: PgClient) =>
  tx.query('DELETE FROM kortix.tunnel_connections WHERE tunnel_id = $1', [tunnelId]);

const ownerAccounts = () =>
  db
    .select({ tunnelId: connectorConnections.tunnelId })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.projectId, project.project_id), eq(connectorConnections.ownerId, OWNER)));

describe('a computer unpaired while it is attached', () => {
  test('ensureProjectComputer, behind the catalog and the connection lists, skips it', async () => {
    const machine = await pairMachine('Race laptop');
    await interleave(unpair(machine), () => ensureProjectComputer(project.project_id, OWNER), 'tunnel_');
    expect(await ownerAccounts()).toEqual([]);
  });

  test('POST /projects/:id/computers answers 404, as for an unknown machine', async () => {
    const machine = await pairMachine('Race desktop');
    const res = await interleave(
      unpair(machine),
      async () =>
        app.request(`/v1/projects/${project.project_id}/computers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tunnel_id: machine }),
        }),
      'tunnel_',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Computer not found' });
    expect(await ownerAccounts()).toEqual([]);
  });
});
