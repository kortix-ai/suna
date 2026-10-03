import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tunnelDeviceAuthRequests } from '../src/schema/kortix';

test('device auth foreign key has a nonunique tunnel-led btree index', () => {
  const index = getTableConfig(tunnelDeviceAuthRequests).indexes.find(
    (entry) => entry.config.name === 'idx_tunnel_device_auth_tunnel',
  );
  expect(index).toBeDefined();
  expect(index?.config.unique).toBe(false);
  expect(index?.config.method).toBe('btree');
  expect(index?.config.columns.map((column) => column.name)).toEqual(['tunnel_id']);
});

test('real migration runner queues the index build after committing the batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-device-auth-index-'));
  const statements: string[] = [];
  try {
    const migrations = join(import.meta.dir, '..', 'migrations');
    const file = readdirSync(migrations).find((name) =>
      name.endsWith('_tunnel_device_auth_tunnel_index.concurrent.ts'),
    );
    if (!file) throw new Error('tunnel device auth index migration missing');
    copyFileSync(join(migrations, file), join(dir, file));
    await runner({
      dbClient: {
        query(text: string) {
          statements.push(text);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      },
      direction: 'up', dir, migrationsTable: 'pgmigrations', noLock: true,
      singleTransaction: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const builds = statements.filter((sql) => /create index concurrently/i.test(sql));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/if not exists idx_tunnel_device_auth_tunnel\s+on kortix\.tunnel_device_auth_requests using btree \(tunnel_id\)/i);
    expect(builds[0]?.split(';')).toHaveLength(2);
    const commit = statements.findIndex((sql) => sql.trim() === 'COMMIT;');
    expect(commit).toBeGreaterThan(-1);
    expect(statements.indexOf(builds[0] ?? '')).toBeGreaterThan(commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
