/**
 * The computer_accounts backfill on a migrated PostgreSQL: Computers profiles
 * (`connectors.config.tunnel_ids`) become one computer account per machine.
 * Synthetic fixtures only. Runs the migration's own `up()` twice to prove it
 * is idempotent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;
const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260928210716000_computer_accounts_backfill.concurrent.ts',
);

const TEAM = crypto.randomUUID();
// Another team account: its owner-less machine must not join TEAM's project.
const FOREIGN_TEAM = crypto.randomUUID();
const PERSON = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PROFILE = crypto.randomUUID();
const AGGREGATE = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const HTTP = crypto.randomUUID();
const MAC = crypto.randomUUID();
const MAC_TWIN = crypto.randomUUID();
const SERVER = crypto.randomUUID();
const GONE = crypto.randomUUID();
const FOREIGN = crypto.randomUUID();
const PROFILE_SLOT = crypto.randomUUID();
const AGGREGATE_SLOT = crypto.randomUUID();
const HTTP_DEFAULT = crypto.randomUUID();

let client: pg.Client;

async function runBackfill() {
  const migration = (await import(migrationPath)) as {
    up: (pgm: unknown) => Promise<void>;
  };
  await migration.up({
    noTransaction: () => undefined,
    sql: () => undefined,
    db: { query: (text: string) => client.query(text) },
  });
}

async function connectionsOf(connectorId: string) {
  const { rows } = await client.query(
    `select owner_type, owner_id, label, status, is_default, tunnel_id::text
       from kortix.connector_connections where connector_id = $1`,
    [connectorId],
  );
  return rows.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
}

describe.skipIf(!databaseUrl)('computer_accounts backfill — migrated PostgreSQL', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: superuserUrl });
    await admin.connect();
    await admin.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [PERSON]);
    await admin.end();

    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `insert into kortix.accounts (account_id, name) values ($1, 'backfill-team'), ($2, 'backfill-person'), ($3, 'backfill-foreign')`,
      [TEAM, PERSON, FOREIGN_TEAM],
    );
    await client.query(
      `insert into kortix.projects (project_id, account_id, name, repo_url)
       values ($1, $2, 'backfill', 'https://example.invalid/backfill.git'),
              ($3, $2, 'backfill-other', 'https://example.invalid/backfill-other.git')`,
      [PROJECT, TEAM, OTHER_PROJECT],
    );
    await client.query(
      `insert into kortix.tunnel_connections (tunnel_id, account_id, name) values
         ($1, $4, 'Mac'), ($2, $4, 'mac'), ($3, $5, 'Server'), ($6, $7, 'Foreign')`,
      [MAC, MAC_TWIN, SERVER, PERSON, TEAM, FOREIGN, FOREIGN_TEAM],
    );
    const auth = { type: 'none', in: 'header', name: null, prefix: null };
    await client.query(
      `insert into kortix.connectors (connector_id, account_id, project_id, slug, name, provider_type, config) values
         ($1, $4, $5, 'computer', 'Computer Tunnel', 'computer', $7::jsonb),
         ($2, $4, $6, 'computer', 'Computer Tunnel', 'computer', $8::jsonb),
         ($3, $4, $5, 'crm', 'CRM', 'http', $9::jsonb)`,
      [
        PROFILE,
        AGGREGATE,
        HTTP,
        TEAM,
        PROJECT,
        OTHER_PROJECT,
        JSON.stringify({
          auth,
          sensitive: true,
          computer_profile: true,
          tunnel_ids: [MAC, MAC_TWIN, SERVER, GONE, FOREIGN],
          tunnel_account_ids: [PERSON, TEAM],
        }),
        JSON.stringify({ auth }),
        JSON.stringify({ baseUrl: 'https://example.invalid', auth: { type: 'bearer' } }),
      ],
    );
    await client.query(
      `insert into kortix.connector_connections
         (connection_id, account_id, project_id, connector_id, owner_type, owner_id, label, is_default) values
         ($1, $4, $5, $7, 'project', null, 'Computer Tunnel', true),
         ($2, $4, $6, $8, 'project', null, 'Computer Tunnel', true),
         ($3, $4, $5, $9, 'project', null, 'CRM', true)`,
      [PROFILE_SLOT, AGGREGATE_SLOT, HTTP_DEFAULT, TEAM, PROJECT, OTHER_PROJECT, PROFILE, AGGREGATE, HTTP],
    );
  });

  afterAll(async () => {
    await client?.end();
  });

  test('converts a profile into one account per surviving machine, twice without change', async () => {
    await runBackfill();

    const { rows: machines } = await client.query(
      `select tunnel_id::text, owner_user_id::text from kortix.tunnel_connections
        where tunnel_id = any($1::uuid[]) order by name`,
      [[MAC, MAC_TWIN, SERVER, FOREIGN]],
    );
    expect(Object.fromEntries(machines.map((row) => [row.tunnel_id, row.owner_user_id]))).toEqual({
      [MAC]: PERSON,
      [MAC_TWIN]: PERSON,
      [SERVER]: null,
      [FOREIGN]: null,
    });

    const expected = [
      {
        owner_type: 'project',
        owner_id: null,
        label: 'Computer Tunnel',
        status: 'revoked',
        is_default: false,
        tunnel_id: null,
      },
      { owner_type: 'member', owner_id: PERSON, label: 'Mac', status: 'active', is_default: true, tunnel_id: MAC },
      {
        owner_type: 'member',
        owner_id: PERSON,
        label: 'mac (2)',
        status: 'active',
        is_default: false,
        tunnel_id: MAC_TWIN,
      },
      { owner_type: 'project', owner_id: null, label: 'Server', status: 'active', is_default: true, tunnel_id: SERVER },
    ];
    expect(await connectionsOf(PROFILE)).toEqual(expected);

    const { rows: profile } = await client.query(
      `select config from kortix.connectors where connector_id = $1`,
      [PROFILE],
    );
    expect(profile[0].config).toEqual({
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      sensitive: true,
    });

    expect(await connectionsOf(AGGREGATE)).toEqual([
      {
        owner_type: 'project',
        owner_id: null,
        label: 'Computer Tunnel',
        status: 'revoked',
        is_default: false,
        tunnel_id: null,
      },
    ]);
    expect(await connectionsOf(HTTP)).toEqual([
      { owner_type: 'project', owner_id: null, label: 'CRM', status: 'active', is_default: true, tunnel_id: null },
    ]);

    await runBackfill();
    expect(await connectionsOf(PROFILE)).toEqual(expected);
  });
});
