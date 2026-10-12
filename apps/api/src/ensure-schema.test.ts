/**
 * The boot schema-drift probe runs on the SHARED request pool.
 *
 * It used to open its own transient `postgres(...)` client at boot; the
 * rolling-deployment ceiling had to count that as one extra connection per
 * starting task (KRTX-2020 raised the request pool with exactly the headroom
 * freeing that client bought). The probe must query through `./shared/db` and
 * must NEVER close that pool.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('./config', () => ({
  config: { DATABASE_URL: 'postgres://mock:5432/kortix', INTERNAL_KORTIX_ENV: 'prod' },
}));

let executed = 0;
let endAccesses = 0;
const fakeDb = {
  execute() {
    executed += 1;
    return Promise.resolve([{ table_name: 'accounts' }, { table_name: 'projects' }]);
  },
};
Object.defineProperty(fakeDb, 'end', {
  get() {
    endAccesses += 1;
    return () => Promise.resolve();
  },
});
mock.module('./shared/db', () => ({ db: fakeDb }));

const { ensureSchema } = await import('./ensure-schema');

describe('boot schema probe', () => {
  test('queries through the shared request pool and never closes it', async () => {
    // KORTIX_LOCAL_DEV/ENV_MODE unset → the deployed branch: drift probe only.
    await ensureSchema();
    expect(executed).toBe(1);
    expect(endAccesses).toBe(0);
  });
});
