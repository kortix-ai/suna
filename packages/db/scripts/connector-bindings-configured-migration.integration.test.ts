import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-connector-bindings-configured-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_project_session_connector_bindings_configured.sql').scanSync({
    cwd: migrationDirectory,
  }),
);
let containerStarted = false;

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
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

describe.skipIf(!dockerAvailable)(
  'connector bindings configured migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;

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
      containerStarted = true;

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const probe = Bun.spawnSync(
          // OVER TCP (-h), never the default unix socket. The postgres image runs
          // a TEMPORARY server during initdb that listens on the SOCKET ONLY, so
          // a socket probe goes green while that one is up — and the real
          // server's restart then fails the very next statement with
          // "connection to server on socket ... No such file or directory".
          // A TCP probe cannot see the temporary server at all, so passing it
          // means the real one is up.
          [
            'docker',
            'exec',
            container,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
            '-d',
            'testdb',
            '-c',
            'SELECT 1',
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) {
          dockerPsql(`
            CREATE SCHEMA kortix;
            CREATE TABLE kortix.project_sessions (
              session_id text PRIMARY KEY
            );
            INSERT INTO kortix.project_sessions (session_id) VALUES ('existing');
          `);
          return;
        }
        await Bun.sleep(250);
      }

      throw new Error('Disposable PostgreSQL did not become ready');
    }, 30_000);

    afterAll(() => {
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', container], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    });

    test('defaults existing and new sessions to false and accepts explicit true', async () => {
      expect(migrationNames).toHaveLength(1);
      const migration = await Bun.file(resolve(migrationDirectory, migrationNames[0])).text();

      dockerPsql(`
        ${migration}
        INSERT INTO kortix.project_sessions (session_id) VALUES ('defaulted');
        INSERT INTO kortix.project_sessions (session_id, connector_bindings_configured)
        VALUES ('configured', true);
      `);

      expect(
        dockerPsql(`
          SELECT session_id || ':' || connector_bindings_configured::text
          FROM kortix.project_sessions
          ORDER BY session_id;
        `),
      ).toBe('configured:true\ndefaulted:false\nexisting:false');

      expect(
        dockerPsql(`
          SELECT is_nullable || ':' || column_default
          FROM information_schema.columns
          WHERE table_schema = 'kortix'
            AND table_name = 'project_sessions'
            AND column_name = 'connector_bindings_configured';
        `),
      ).toBe('NO:false');
    });
  },
);
