import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * Regression test for Better Stack error 97669531…
 * (https://errors.betterstack.com/team/t502678/errors/97669531…).
 *
 * Symptom: GET /v1/accounts/:id/invites (and every other Drizzle `select()`
 * against kortix.account_invitations) 500'd in prod with
 *   column "accepted_by_user_id" does not exist
 * because the Drizzle schema gained `acceptedByUserId` and the API began
 * projecting it, but the node-pg-migrate migration that actually adds the
 * column to deployed databases was never created — only an orphaned
 * Drizzle-generated SQL file landed in packages/db/drizzle/, which the deploy
 * runner does not apply.
 *
 * This test stands up a real PostgreSQL, builds account_invitations in its
 * PRE-migration shape (matching the committed baseline), applies the fix
 * migration, and asserts:
 *   1. the `accepted_by_user_id` column now exists, and
 *   2. the exact failing SELECT from the error (the Drizzle-generated query for
 *      GET /v1/accounts/:id/invites) succeeds instead of raising 42703.
 *
 * Docker is required; the suite is skipped when docker is unavailable (same
 * gate pattern as runtime-identity-migration.integration.test.ts).
 */

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const container = `kortix-invite-accept-${crypto.randomUUID().slice(0, 8)}`;

function dockerPsql(sql: string, allowFailure = false) {
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
  return { exitCode: result.exitCode, output };
}

// PRE-migration shape of kortix.account_invitations, taken from the committed
// baseline (20260621094136410_baseline.sql). Crucially: NO accepted_by_user_id.
// This is the exact state prod was in when the 500s fired.
const PRE_MIGRATION_SCHEMA = `
  CREATE SCHEMA kortix;
  CREATE TYPE kortix.account_role AS ENUM ('owner', 'admin', 'member');
  CREATE TABLE kortix.accounts (
    account_id uuid PRIMARY KEY
  );
  CREATE TABLE kortix.account_invitations (
    invite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
    email varchar(255) NOT NULL,
    invited_by uuid,
    initial_role kortix.account_role NOT NULL DEFAULT 'member',
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + '14 days'::interval),
    bootstrap_grants jsonb
  );
`;

describe.skipIf(!dockerAvailable)('invite_accept_identity migration — real PostgreSQL', () => {
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

    // Sanity: confirm the PRE-migration schema really lacks the column, i.e.
    // that this test is set up to reproduce the prod failure mode. The exact
    // failing SELECT from the error must 42703 BEFORE the migration runs.
    dockerPsql(PRE_MIGRATION_SCHEMA);
    const pre = dockerPsql(
      `\\set VERBOSITY verbose\nSELECT accepted_by_user_id FROM kortix.account_invitations LIMIT 1;`,
      true,
    );
    expect(pre.exitCode).not.toBe(0);
    expect(pre.output).toContain('42703'); // undefined_column
    expect(pre.output).toContain('accepted_by_user_id');
  }, 30_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('adds the accepted_by_user_id column', async () => {
    const migration = await Bun.file(
      resolve(import.meta.dir, '..', 'migrations', '20260712220000000_invite_accept_identity.sql'),
    ).text();
    // Apply only the Up portion (everything before the "-- Down Migration"
    // marker), as node-pg-migrate would.
    const up = migration.split(/^\s*--\s*Down\s+Migration/im)[0] ?? migration;
    dockerPsql(up);

    const col = dockerPsql(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='kortix' AND table_name='account_invitations'
          AND column_name='accepted_by_user_id';`,
    );
    expect(col.output.trim()).toBe('uuid');
  });

  test('the exact failing GET /v1/accounts/:id/invites SELECT now succeeds', () => {
    dockerPsql(`
      INSERT INTO kortix.accounts(account_id) VALUES
        ('4c66e49f-142f-4cad-af2c-eb24743fc809');
      INSERT INTO kortix.account_invitations
        (account_id, email, initial_role, expires_at)
      VALUES
        ('4c66e49f-142f-4cad-af2c-eb24743fc809', 'invitee@example.test', 'member',
         now() + interval '7 days');
    `);

    // This is the verbatim query Drizzle emits for GET /v1/accounts/:id/invites
    // (members.ts: db.select().from(accountInvitations).where(...)). Before the
    // migration it raised `column "accepted_by_user_id" does not exist`.
    const result = dockerPsql(`
      SELECT invite_id, account_id, email, invited_by, initial_role,
             bootstrap_grants, accepted_at, accepted_by_user_id,
             created_at, expires_at
        FROM kortix.account_invitations
       WHERE account_id = '4c66e49f-142f-4cad-af2c-eb24743fc809'
         AND accepted_at IS NULL
         AND expires_at > now();
    `);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('invitee@example.test');
    // The column is nullable; a never-accepted invite reads as NULL, not an
    // error — which is what the accept handler's
    // `if (alreadyAccepted && invite.acceptedByUserId …)` guard depends on.
    expect(result.output).toContain('|');
  });

  test('accept stamps accepted_by_user_id', () => {
    // Mirrors the accept handler's persisted identity stamp. The API-level 409
    // guard for a different identity is covered by the accounts contract tests.
    dockerPsql(`
      UPDATE kortix.account_invitations
         SET accepted_at = now(), accepted_by_user_id = '00000000-0000-4000-a000-0000000000aa'
       WHERE email = 'invitee@example.test';
    `);
    const row = dockerPsql(
      `SELECT accepted_by_user_id FROM kortix.account_invitations
        WHERE email = 'invitee@example.test';`,
    );
    expect(row.output).toContain('00000000-0000-4000-a000-0000000000aa');
  });

  test('the migration is idempotent (re-applying is a no-op)', async () => {
    const migration = await Bun.file(
      resolve(import.meta.dir, '..', 'migrations', '20260712220000000_invite_accept_identity.sql'),
    ).text();
    const up = migration.split(/^\s*--\s*Down\s+Migration/im)[0] ?? migration;
    // ADD COLUMN IF NOT EXISTS → second application must not error and must not
    // duplicate the column.
    expect(() => dockerPsql(up)).not.toThrow();
    const cols = dockerPsql(
      `SELECT count(*) FROM information_schema.columns
        WHERE table_schema='kortix' AND table_name='account_invitations'
          AND column_name='accepted_by_user_id';`,
    );
    expect(cols.output.trim()).toBe('1');
  });
});
