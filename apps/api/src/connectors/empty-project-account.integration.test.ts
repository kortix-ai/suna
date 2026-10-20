/**
 * connectors_v2 stops sync from seeding an empty "Everyone in project" account
 * (KRTX-2317) for ordinary connectors, keeps it for channel connectors (the
 * install token is the project's own identity), and changes nothing with the
 * flag off.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { ConnectorSpec } from '../projects/connectors';
import { db } from '../shared/db';
import { skipsEmptyProjectAccount } from './sync';

const ACCOUNT = crypto.randomUUID();
const ON = crypto.randomUUID();
const OFF = crypto.randomUUID();

const spec = (provider: ConnectorSpec['provider'], auth?: ConnectorSpec['auth']) => ({ provider, auth }) as ConnectorSpec;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'empty-account-test' });
  await db.insert(projects).values([
    { projectId: ON, accountId: ACCOUNT, name: 'v2-on', repoUrl: 'https://example.test/on.git', metadata: { experimental: { connectors_v2: true } } },
    { projectId: OFF, accountId: ACCOUNT, name: 'v2-off', repoUrl: 'https://example.test/off.git' },
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('only an ordinary connector of a connectors_v2 project skips the empty project account', async () => {
  expect(await skipsEmptyProjectAccount(ON, spec('mcp'))).toBe(true);
  // A public server needs no credential: its project account is the connection.
  expect(await skipsEmptyProjectAccount(ON, spec('mcp', { type: 'none' } as ConnectorSpec['auth']))).toBe(false);
  expect(await skipsEmptyProjectAccount(ON, spec('composio'))).toBe(true);
  expect(await skipsEmptyProjectAccount(ON, spec('channel'))).toBe(false);
  expect(await skipsEmptyProjectAccount(OFF, spec('mcp'))).toBe(false);
});
