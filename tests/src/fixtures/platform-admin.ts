/**
 * Run-scoped platform-admin fixture for the live ke2e suite.
 *
 * Platform admin is intentionally not backed by the server's static admin API
 * key: admin routes authenticate a real Supabase user and then resolve that
 * user's role from kortix.platform_user_roles. Release QA has direct access to
 * the staging database, so it can grant a synthetic user the role for exactly
 * one run and remove it during teardown.
 */
import type { Env } from '../core/env';

interface RoleDb {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type OpenRoleDb = (databaseUrl: string) => Promise<RoleDb>;

async function openRoleDb(databaseUrl: string): Promise<RoleDb> {
  const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function execute(
  databaseUrl: string,
  open: OpenRoleDb,
  text: string,
  accountId: string,
): Promise<void> {
  const client = await open(databaseUrl);
  try {
    await client.query(text, [accountId]);
  } finally {
    await client.end();
  }
}

/**
 * Grant a synthetic user the platform super-admin role and return its exact
 * cleanup operation. This mutation is categorically forbidden against prod.
 */
export async function grantEphemeralPlatformAdmin(
  env: Env,
  accountId: string,
  open: OpenRoleDb = openRoleDb,
): Promise<() => Promise<void>> {
  if (env.target === 'prod') {
    throw new Error('refusing to grant an ephemeral platform role against production');
  }
  if (!env.databaseUrl) {
    throw new Error('KE2E_DATABASE_URL is required for the ephemeral platform-admin fixture');
  }

  await execute(
    env.databaseUrl,
    open,
    `INSERT INTO kortix.platform_user_roles (account_id, role)
     VALUES ($1::uuid, 'super_admin'::kortix.platform_role)
     ON CONFLICT (account_id) DO UPDATE SET role = EXCLUDED.role`,
    accountId,
  );

  return async () => {
    await execute(
      env.databaseUrl!,
      open,
      `DELETE FROM kortix.platform_user_roles
       WHERE account_id = $1::uuid
         AND role = 'super_admin'::kortix.platform_role`,
      accountId,
    );
  };
}
