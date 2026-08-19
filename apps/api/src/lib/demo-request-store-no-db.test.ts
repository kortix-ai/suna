// The no-database branch of the contact_forms write. Its own file because
// `mock.module` bindings are snapshotted at import, so `hasDatabase` cannot be
// flipped per test inside demo-request-store.test.ts.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let executeCalls = 0;

mock.module('../shared/db', () => ({
  hasDatabase: false,
  db: {
    execute: async () => {
      executeCalls += 1;
      return [] as any;
    },
  },
}));

const { recordDemoRequestSubmission } = await import('./demo-request-store');

const consoleError = console.error;
let logged: string[] = [];

beforeEach(() => {
  executeCalls = 0;
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.error = consoleError;
});

test('recordDemoRequestSubmission: no DATABASE_URL → false, no query, logged', async () => {
  expect(await recordDemoRequestSubmission({ email: 'ada@example.com' })).toBe(false);
  expect(executeCalls).toBe(0);
  expect(logged.join('\n')).toContain('no DATABASE_URL');
});
