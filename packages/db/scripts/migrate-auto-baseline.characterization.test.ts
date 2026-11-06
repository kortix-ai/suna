import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import pg from 'pg';

const actual = await import('node-pg-migrate');
const runner = mock(async (..._args: unknown[]) => []);
// mock.module is process-wide in Bun: after this file, every other suite gets the real runner back.
let stubbed = true;
mock.module('node-pg-migrate', () => ({
  ...actual,
  runner: (...args: Parameters<typeof actual.runner>) => (stubbed ? runner(...args) : actual.runner(...args)),
}));

const connect = spyOn(pg.Client.prototype, 'connect').mockImplementation(async function (this: pg.Client) { return this; });
const end = spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {});
const query = spyOn(pg.Client.prototype, 'query');
const originalArgv = process.argv;
const originalUrl = process.env.DATABASE_URL;
const log = spyOn(console, 'log').mockImplementation(() => {});
const warn = spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  runner.mockClear();
  process.env.DATABASE_URL = 'postgres://synthetic@localhost/synthetic';
  process.argv = ['bun', 'migrate.ts', 'up'];
});
afterEach(() => { process.argv = originalArgv; });
afterAll(() => {
  stubbed = false;
  connect.mockRestore(); end.mockRestore(); query.mockRestore(); log.mockRestore(); warn.mockRestore();
  if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
});

/** Runs `migrate.ts up` against a fake server and returns the runner calls. */
async function runUp(server: { schema: boolean; ledgerTable: boolean; ledgerRows: number }, tag: string) {
  query.mockImplementation(async (sql) => {
    const text = String(sql).toLowerCase();
    const rows = text.includes("to_regclass('kortix.accounts')") ? [{ exists: server.schema }]
      : text.includes('to_regclass') ? [{ exists: server.ledgerTable }]
      : text.includes('count(*)') ? [{ n: server.ledgerRows }]
      : [];
    return { rows, rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  });
  await import(`./migrate.ts?${tag}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return runner.mock.calls.map(([options]) => options as Record<string, unknown>);
}

test('an existing schema with an empty ledger fakes exactly one migration before the real up', async () => {
  const calls = await runUp({ schema: true, ledgerTable: true, ledgerRows: 0 }, 'empty-ledger');
  expect(calls[0]).toMatchObject({ direction: 'up', count: 1, fake: true });
  expect(calls.filter((call) => call.fake === true)).toHaveLength(1);
  expect(calls.at(-1)).toMatchObject({ direction: 'up', count: Number.POSITIVE_INFINITY });
  expect(calls.at(-1)?.fake).toBeUndefined();
});

test('an existing schema with no ledger table also fakes exactly one migration', async () => {
  const calls = await runUp({ schema: true, ledgerTable: false, ledgerRows: 0 }, 'no-ledger-table');
  expect(calls.filter((call) => call.fake === true)).toHaveLength(1);
  expect(calls[0]).toMatchObject({ count: 1, fake: true });
});

test('a fresh database fakes nothing', async () => {
  const calls = await runUp({ schema: false, ledgerTable: false, ledgerRows: 0 }, 'fresh');
  expect(calls.filter((call) => call.fake === true)).toHaveLength(0);
  expect(calls).toHaveLength(1);
});

test('an existing schema with a recorded ledger fakes nothing', async () => {
  const calls = await runUp({ schema: true, ledgerTable: true, ledgerRows: 5 }, 'tracked');
  expect(calls.filter((call) => call.fake === true)).toHaveLength(0);
});
