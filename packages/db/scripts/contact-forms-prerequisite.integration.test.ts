import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerAvailable } from './docker-available';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';

// A disposable PostgreSQL database proves the actual runtime SQL, not its text.
test.skipIf(!dockerAvailable)(
  'pending Sales producers restore contact storage without losing existing submissions',
  () => {
    const runtime = materializeMigrationRuntimeDirectory(join(import.meta.dir, '../migrations'));
    const container = `contact-prerequisite-${crypto.randomUUID()}`;
    function sql(statement: string) {
      const result = Bun.spawnSync(
        [
          'docker',
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'supabase_admin',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-At',
        ],
        { stdin: Buffer.from(statement), stdout: 'pipe', stderr: 'pipe' },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    }
    try {
      const started = Bun.spawnSync(
        [
          'docker',
          'run',
          '--rm',
          '-d',
          '--name',
          container,
          '-e',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          'public.ecr.aws/supabase/postgres:17.6.1.165',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(started.exitCode).toBe(0);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const probe = Bun.spawnSync(
          ['docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'supabase_admin'],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) {
          ready = true;
          break;
        }
        Bun.sleepSync(200);
      }
      expect(ready).toBe(true);
      sql(`DROP SCHEMA auth CASCADE; CREATE SCHEMA kortix; CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid, email text, email_confirmed_at timestamptz, created_at timestamptz, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
      CREATE TABLE kortix.sales_event_outbox(event_id text PRIMARY KEY, payload jsonb);`);
      const contents = readFileSync(
        join(runtime.path, '20261103164800000_sales_event_producers.sql'),
        'utf8',
      );
      sql(contents);
      const id = sql(
        `INSERT INTO public.contact_forms(data) VALUES ('{"email":"synthetic@example.com","form":"demo"}') RETURNING id;`,
      ).split('\n')[0];
      expect(sql('SELECT count(*) FROM kortix.sales_event_outbox;').trim()).toBe('1');
      sql(
        `DROP TRIGGER sales_demo_requested ON public.contact_forms; DROP TRIGGER sales_signup_confirmed ON auth.users; DROP FUNCTION kortix.enqueue_demo_requested(); DROP FUNCTION kortix.enqueue_confirmed_signup();`,
      );
      sql(contents);
      expect(sql(`SELECT count(*) FROM public.contact_forms WHERE id = '${id}';`).trim()).toBe('1');
      sql(
        `SET ROLE anon; INSERT INTO public.contact_forms(data) VALUES ('{"source":"careers-application","opening":"synthetic"}'); RESET ROLE;`,
      );
      expect(sql('SELECT count(*) FROM kortix.sales_event_outbox;').trim()).toBe('1');
    } finally {
      Bun.spawnSync(['docker', 'rm', '-fv', container], { stdout: 'ignore', stderr: 'ignore' });
      runtime.cleanup();
    }
  },
  60_000,
);
