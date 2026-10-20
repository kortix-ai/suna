import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { dropLocalInvalidIndexes } from './local-invalid-index-repair';

const calls: string[] = [];
const connect = spyOn(pg.Client.prototype, 'connect').mockImplementation(async function (this: pg.Client) { calls.push('connect'); return this; });
const end = spyOn(pg.Client.prototype, 'end').mockImplementation(async () => { calls.push('end'); });
const query = spyOn(pg.Client.prototype, 'query');
afterEach(() => { calls.length = 0; });
afterAll(() => { connect.mockRestore(); end.mockRestore(); query.mockRestore(); });

test('empty catalog connects, reads and closes exactly once', async () => {
  query.mockImplementation(async () => { calls.push('query'); return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }; });
  expect(await dropLocalInvalidIndexes('postgres://synthetic')).toEqual([]);
  expect(calls).toEqual(['connect', 'query', 'query', 'end']);
});

test('query failure closes and propagates the same error', async () => {
  const error = new Error('synthetic query failure');
  query.mockImplementation(async () => { calls.push('query'); throw error; });
  await expect(dropLocalInvalidIndexes('postgres://synthetic')).rejects.toBe(error);
  expect(calls).toEqual(['connect', 'query', 'end']);
});

test('connection failure never runs queries or end', async () => {
  const error = new Error('synthetic connect failure');
  connect.mockImplementationOnce(async () => { calls.push('connect'); throw error; });
  await expect(dropLocalInvalidIndexes('postgres://synthetic')).rejects.toBe(error);
  expect(calls).toEqual(['connect']);
});

test('closing failure replaces a query failure', async () => {
  const error = new Error('synthetic closing failure');
  query.mockImplementation(async () => { throw new Error('query failed'); });
  end.mockImplementationOnce(async () => { calls.push('end'); throw error; });
  await expect(dropLocalInvalidIndexes('postgres://synthetic')).rejects.toBe(error);
  expect(calls).toEqual(['connect', 'end']);
});
