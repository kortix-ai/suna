import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { repairLocalWarmSessionIndex } from './local-warm-session-index-repair';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `kortix-local-warm-index-${crypto.randomUUID().slice(0, 8)}`;
let databaseUrl = '';

function psql(sql: string, allowFailure = false) {
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
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output: output.trim() };
}

const SCHEMA = `
  drop schema if exists kortix cascade;
  create schema kortix;
  create table kortix.project_sessions (
    session_id text primary key,
    project_id uuid not null,
    created_by uuid,
    metadata jsonb default '{}'::jsonb,
    created_at timestamptz not null,
    updated_at timestamptz not null
  );
`;

describe.skipIf(!dockerAvailable)('local warm-session index repair — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    const port = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).stdout.toString().trim().split(':').at(-1);
    if (!port) throw new Error('Disposable PostgreSQL did not publish a port');
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/testdb`;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = Bun.spawnSync(
        [
          'docker',
          'exec',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          'testdb',
          '-c',
          'select 1',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) return;
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 30_000);

  beforeEach(() => psql(SCHEMA));

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('keeps the newest available row and rebuilds a valid unique index', async () => {
    psql(`
      insert into kortix.project_sessions values
        ('older', '00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001',
         '{"warm_session":{"state":"available","sandbox_slug":"default","created_at":"2026-01-01T00:00:00Z"}}',
         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('newer', '00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001',
         '{"warm_session":{"state":"available","sandbox_slug":"default","created_at":"2026-01-02T00:00:00Z"}}',
         '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      create index idx_project_sessions_one_available_warm
        on kortix.project_sessions (project_id, created_by)
        where false;
      update pg_index
         set indisvalid = false, indisready = false
       where indexrelid = 'kortix.idx_project_sessions_one_available_warm'::regclass;
    `);

    const result = await repairLocalWarmSessionIndex(databaseUrl);
    expect(result).toEqual({ repaired: true, discardedDuplicates: 1 });
    expect(
      psql(`
        select session_id || ':' || (metadata->'warm_session'->>'state') || ':' ||
               coalesce(metadata->'warm_session'->>'discard_reason', '')
          from kortix.project_sessions
         order by session_id;
      `).output,
    ).toBe('newer:available:\nolder:discarded:duplicate_repair');
    expect(
      psql(`
        select indisvalid::text || ':' || indisready::text
          from pg_index
         where indexrelid = 'kortix.idx_project_sessions_one_available_warm'::regclass;
      `).output,
    ).toBe('true:true');
    const duplicate = psql(
      `
        insert into kortix.project_sessions values
          ('duplicate', '00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001',
           '{"warm_session":{"state":"available"}}', now(), now());
      `,
      true,
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.output).toContain('idx_project_sessions_one_available_warm');
  });

  test('does nothing when the canonical index is already valid', async () => {
    psql(`
      create unique index idx_project_sessions_one_available_warm
        on kortix.project_sessions (project_id, created_by)
        where created_by is not null
          and metadata->'warm_session'->>'state' = 'available'
          and coalesce(metadata->>'deletedAt', '') = '';
    `);

    expect(await repairLocalWarmSessionIndex(databaseUrl)).toEqual({
      repaired: false,
      discardedDuplicates: 0,
    });
  });
});
