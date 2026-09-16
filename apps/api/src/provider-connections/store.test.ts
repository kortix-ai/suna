import { beforeEach, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { parseCodexAuth } from '../llm-gateway/credentials/codex-core';

let responses: unknown[][][] = [];
let queries: { sql: string; params: unknown[] }[] = [];
const database = drizzle(async (sql, params) => {
  queries.push({ sql, params });
  const rows = responses.shift();
  if (!rows) throw new Error(`Unexpected database operation: ${sql}`);
  return { rows };
});
mock.module('../shared/db', () => ({
  db: Object.assign(database, {
    transaction: async (callback: (tx: typeof database) => Promise<unknown>) => callback(database),
  }),
}));
mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-provider-encryption' } }));
mock.module('./adapters', () => ({
  providerConnectionAdapter: (id: string) => ({
    id,
    authType: id === 'codex' ? 'device_oauth' : 'api_key',
    credentialIdentity:
      id === 'codex' ? (value: string) => parseCodexAuth(value)?.accountId : undefined,
  }),
}));
const { seal } = await import('./crypto');
const { saveUserProviderConnection, deleteUserProviderConnection, resolveUserProviderConnection } =
  await import('./store');

const timestamp = '2026-09-16T00:00:00.000Z';
const connection = (id: string, value: string, slot = id, provider = 'openai') => [
  id,
  'alice',
  provider,
  provider === 'codex' ? 'device_oauth' : 'api_key',
  slot,
  id,
  seal('alice', provider, 'credential', value),
  timestamp,
  timestamp,
];
const binding = (pool: boolean) => ['project', 'alice', 'openai', 'first', pool, timestamp];

beforeEach(() => {
  responses = [];
  queries = [];
});

test('no explicit project binding returns no personal credential', async () => {
  responses = [[]];
  expect(await resolveUserProviderConnection('project', 'alice', 'openai')).toBeNull();
  expect(queries).toHaveLength(1);
  expect(queries[0]!.params).toEqual(['project', 'alice', 'openai']);
});

test('single selection reads only the bound connection owned by the authenticated user', async () => {
  responses = [[binding(false)], [connection('first', 'first-key')]];
  const result = await resolveUserProviderConnection('project', 'alice', 'openai', 'session');
  expect(result?.value).toBe('first-key');
  expect(queries[1]!.params).toEqual(['alice', 'openai', 'first']);
  expect(responses).toHaveLength(0);
});

test('a session keeps its pool member even when another member is listed first', async () => {
  responses = [
    [binding(true)],
    [connection('first', 'first-key'), connection('second', 'second-key')],
    [['session']],
    [['session', 'alice', 'openai', 'second']],
  ];
  const result = await resolveUserProviderConnection('project', 'alice', 'openai', 'session');
  expect(result?.value).toBe('second-key');
  expect(queries[1]!.params).toEqual(['alice', 'openai']);
  expect(queries[2]!.params).toEqual(['session', 'project']);
  expect(queries[3]!.params).toEqual(['session', 'alice', 'openai']);
  expect(queries.every((query) => !query.sql.startsWith('insert'))).toBe(true);
});

test('concurrent session selection returns the database winner instead of its proposed pool member', async () => {
  responses = [
    [binding(true)],
    [connection('first', 'first-key'), connection('second', 'second-key')],
    [['session']],
    [],
    [],
    [connection('second', 'second-key')],
  ];
  const result = await resolveUserProviderConnection('project', 'alice', 'openai', 'session');
  expect(result?.connectionId).toBe('second');
  expect(queries[4]!.sql).toContain('on conflict do nothing');
  expect(queries[5]!.params).toEqual(['session', 'alice', 'openai']);
});

test('a pool cannot attach a credential to a session outside the requested project', async () => {
  responses = [[binding(true)], [connection('first', 'first-key')], []];
  await expect(
    resolveUserProviderConnection('project', 'alice', 'openai', 'foreign-session'),
  ).rejects.toThrow('Session not found in this project');
  expect(queries[2]!.params).toEqual(['foreign-session', 'project']);
});

test('direct requests choose only from the authenticated user pool', async () => {
  responses = [[binding(true)], [connection('second', 'second-key')]];
  expect((await resolveUserProviderConnection('project', 'alice', 'openai'))?.value).toBe(
    'second-key',
  );
  expect(queries).toHaveLength(2);
});

test('adding an already saved key updates the same connection instead of duplicating the pool', async () => {
  const row = connection('first', 'same-key');
  responses = [[], [row], [row]];
  const result = await saveUserProviderConnection('alice', 'openai', 'same-key', {
    create: true,
    label: 'Work',
  });
  expect(result.connection_id).toBe('first');
  expect(queries[1]!.params).toEqual(['alice', 'openai']);
  expect(queries[2]!.sql).toContain('update');
  expect(queries[2]!.params).toContain('Work');
  expect(JSON.stringify(result)).not.toContain('same-key');
});

test('updating another users connection is rejected without writing credentials', async () => {
  responses = [[], []];
  await expect(
    saveUserProviderConnection('alice', 'openai', 'key', { connection_id: 'foreign' }),
  ).rejects.toThrow('Provider connection not found');
  expect(queries[1]!.params).toEqual(['alice', 'openai']);
  expect(queries).toHaveLength(2);
});

test('reauthorizing a Codex account updates its existing member when tokens change', async () => {
  const previous = JSON.stringify({ openai: { access: 'old-token', accountId: 'subscription' } });
  const next = JSON.stringify({ openai: { access: 'new-token', accountId: 'subscription' } });
  responses = [
    [],
    [connection('first', previous, 'first', 'codex')],
    [connection('first', next, 'first', 'codex')],
  ];
  const result = await saveUserProviderConnection('alice', 'codex', next, { create: true });
  expect(result.connection_id).toBe('first');
  expect(queries[2]!.sql).toContain('update');
  expect(queries.some((query) => query.sql.startsWith('insert'))).toBe(false);
});

test('removing a pool anchor preserves pooled project use and leaves explicit selections to cascade', async () => {
  responses = [[], [connection('first', 'first-key'), connection('second', 'second-key')], [], []];
  await deleteUserProviderConnection('alice', 'openai', 'first');
  expect(queries[2]!.params).toEqual(['second', 'first', 'alice', true]);
  expect(queries[3]!.params).toEqual(['alice', 'openai', 'first']);
});

test('deleting a foreign connection performs no mutation', async () => {
  responses = [[], []];
  await deleteUserProviderConnection('alice', 'openai', 'foreign');
  expect(queries).toHaveLength(2);
  expect(queries[1]!.params).toEqual(['alice', 'openai']);
});

test('a full pool rejects another connection before insert', async () => {
  responses = [
    [],
    Array.from({ length: 10 }, (_, index) => connection(`id-${index}`, `key-${index}`)),
  ];
  await expect(
    saveUserProviderConnection('alice', 'openai', 'new-key', { create: true }),
  ).rejects.toThrow('up to 10 personal connections');
  expect(queries).toHaveLength(2);
});
