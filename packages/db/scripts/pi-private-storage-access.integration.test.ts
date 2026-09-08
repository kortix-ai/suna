import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-pi-storage-access-${crypto.randomUUID().slice(0, 8)}`;

function dockerPsql(sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

const tables = ['session_worker_log', 'pi_runtime_artifacts', 'session_attachments', 'filesystems', 'filesystem_files', 'filesystem_blobs'];

describe.skipIf(!dockerAvailable)('Pi private storage — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'testdb', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    dockerPsql(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE api_owner;
      CREATE SCHEMA kortix AUTHORIZATION api_owner;
      GRANT USAGE ON SCHEMA kortix TO anon, authenticated, service_role;
      SET ROLE api_owner;
      ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT ALL ON TABLES TO service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT ON TABLES TO anon;
      ${tables.map(table => `CREATE TABLE kortix.${table}(secret text); INSERT INTO kortix.${table} VALUES ('private');`).join('\n')}
      RESET ROLE;
    `);
    const root = resolve(import.meta.dir, '..', 'migrations');
    const paths = [...new Bun.Glob('*_pi_private_storage_access.sql').scanSync(root)];
    if (paths.length) dockerPsql(await Bun.file(resolve(root, paths[0]!)).text());
  }, 30_000);
  afterAll(() => { Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' }); });

  for (const table of tables) {
    test(`${table}: browser roles have no table privileges; the owner and service retain access`, () => {
      for (const role of ['anon', 'authenticated']) {
        expect(dockerPsql(`SELECT has_table_privilege('${role}', 'kortix.${table}', 'SELECT,INSERT,UPDATE,DELETE');`)).toBe('f');
      }
      expect(dockerPsql(`SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'kortix.${table}'::regclass;`)).toBe('t');
      expect(dockerPsql(`SET ROLE api_owner; SELECT count(*) FROM kortix.${table}; RESET ROLE;`)).toContain('1');
      expect(dockerPsql(`SET ROLE service_role; SELECT count(*) FROM kortix.${table}; RESET ROLE;`)).toContain('1');
    });
    test(`${table}: accidental blanket grants still cannot expose or modify private rows`, () => {
      dockerPsql(`GRANT SELECT, UPDATE ON kortix.${table} TO anon, authenticated;`);
      try {
        for (const role of ['anon', 'authenticated']) {
          const output = dockerPsql(`SET ROLE ${role}; SELECT count(*) FROM kortix.${table}; UPDATE kortix.${table} SET secret = 'changed'; RESET ROLE;`);
          expect(output).toContain('\n0\n');
          expect(output).toContain('UPDATE 0');
        }
        expect(dockerPsql(`SELECT secret FROM kortix.${table};`)).toBe('private');
      } finally {
        dockerPsql(`REVOKE ALL ON kortix.${table} FROM anon, authenticated;`);
      }
    });
  }
});
