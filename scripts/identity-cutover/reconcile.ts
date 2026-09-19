/** One-time, account-wide ownership transfer between two verified Auth identities. */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

type Pair = { old_id: string; new_id: string; email: string };
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const configPath = args.find(x => x.startsWith('--pairs='))?.slice('--pairs='.length);
if (!configPath) throw Error('Pass --pairs=/path/to/pairs.json');
const pairs: Pair[] = JSON.parse(readFileSync(configPath, 'utf8'));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!pairs.length || pairs.some(p => !uuid.test(p.old_id) || !uuid.test(p.new_id) || !p.email.includes('@') || p.old_id === p.new_id)) throw Error('Invalid identity pairs');
if (new Set(pairs.map(p => p.old_id)).size !== pairs.length || new Set(pairs.map(p => p.new_id)).size !== pairs.length) throw Error('Duplicate identity IDs');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
if (apply && !args.includes('--confirm-identity-cutover')) throw Error('Apply requires --confirm-identity-cutover');

const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'identity-cutover' });
await client.connect();
const results: Record<string, unknown>[] = [];
async function count(sql: string, params: unknown[]) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}
async function changed(sql: string, params: unknown[]) {
  return (await client.query(sql, params)).rowCount ?? 0;
}
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  for (const pair of pairs) {
    const { old_id: oldId, new_id: newId, email } = pair;
    const auth = await client.query(
      `SELECT id::text, lower(email) AS email, is_sso_user FROM auth.users WHERE id IN ($1::uuid,$2::uuid) ORDER BY id`,
      [oldId, newId],
    );
    const oldUser = auth.rows.find(row => row.id === oldId);
    const newUser = auth.rows.find(row => row.id === newId);
    if (!oldUser || !newUser || oldUser.email !== email.toLowerCase() || newUser.email !== email.toLowerCase() || oldUser.is_sso_user || !newUser.is_sso_user) {
      throw Error(`Auth identity mismatch for ${email}`);
    }
    if (await count(`SELECT count(*) FROM kortix.project_sessions WHERE created_by=$1::uuid AND status NOT IN ('stopped','failed')`, [oldId])) {
      throw Error(`Live sessions remain for ${email}`);
    }
    const grantConflicts = await count(
      `SELECT count(*) FROM kortix.project_session_grants old
       JOIN kortix.project_session_grants newer ON newer.session_id=old.session_id AND newer.principal_type=old.principal_type AND newer.principal_id=$2::uuid
       WHERE old.principal_id=$1::uuid AND old.principal_type='member'`,
      [oldId, newId],
    );
    if (grantConflicts) throw Error(`${grantConflicts} session grant conflicts for ${email}`);
    const scimConflicts = await count(
      `SELECT count(*) FROM kortix.account_scim_users old
       JOIN kortix.account_scim_users newer ON newer.account_id=old.account_id AND newer.user_id=$2::uuid AND newer.scim_id<>old.scim_id
       WHERE old.user_id=$1::uuid`,
      [oldId, newId],
    );
    if (scimConflicts) throw Error(`${scimConflicts} SCIM record conflicts for ${email}`);

    const before = {
      sessions: await count('SELECT count(*) FROM kortix.project_sessions WHERE created_by=$1::uuid', [oldId]),
      session_grants: await count("SELECT count(*) FROM kortix.project_session_grants WHERE principal_type='member' AND principal_id=$1::uuid", [oldId]),
      session_tokens: await count('SELECT count(*) FROM kortix.account_tokens WHERE user_id=$1::uuid AND session_id IS NOT NULL', [oldId]),
      memberships: await count('SELECT count(*) FROM kortix.account_memberships WHERE user_id=$1::uuid', [oldId]),
      scim_records: await count('SELECT count(*) FROM kortix.account_scim_users WHERE user_id=$1::uuid', [oldId]),
      roles: await count("SELECT count(*) FROM kortix.role_assignments WHERE principal_type='user' AND principal_id=$1::uuid", [oldId]),
      groups: await count('SELECT count(*) FROM kortix.group_members WHERE user_id=$1::uuid', [oldId]),
    };
    const activeAccounts = (await client.query(
      'SELECT account_id::text FROM kortix.account_memberships WHERE user_id=$1::uuid', [oldId],
    )).rows.map(row => row.account_id as string);
    // The later login must never revive a user whose old membership was already revoked.
    const revokedAlready = before.memberships === 0;

    const membershipInserted = await changed(
      `INSERT INTO kortix.account_memberships (user_id,account_id,joined_at,is_super_admin,scim_external_id)
       SELECT $2::uuid,account_id,joined_at,is_super_admin,scim_external_id
       FROM kortix.account_memberships WHERE user_id=$1::uuid
       ON CONFLICT (user_id,account_id) DO UPDATE SET
         joined_at=least(kortix.account_memberships.joined_at,excluded.joined_at),
         is_super_admin=kortix.account_memberships.is_super_admin OR excluded.is_super_admin,
         scim_external_id=coalesce(excluded.scim_external_id,kortix.account_memberships.scim_external_id)`,
      [oldId, newId],
    );
    const membershipsRemoved = await changed('DELETE FROM kortix.account_memberships WHERE user_id=$1::uuid', [oldId]);
    const scimRebound = await changed('UPDATE kortix.account_scim_users SET user_id=$2::uuid,updated_at=now() WHERE user_id=$1::uuid', [oldId, newId]);
    const groupsInserted = await changed(
      `INSERT INTO kortix.group_members (group_id,user_id,added_by,added_at)
       SELECT gm.group_id,$2::uuid,gm.added_by,gm.added_at
       FROM kortix.group_members gm JOIN kortix.account_groups g ON g.group_id=gm.group_id
       WHERE gm.user_id=$1::uuid AND g.account_id=ANY($3::uuid[])
       ON CONFLICT (group_id,user_id) DO NOTHING`, [oldId, newId, activeAccounts],
    );
    const groupsRemoved = await changed('DELETE FROM kortix.group_members WHERE user_id=$1::uuid', [oldId]);
    const duplicateRolesRemoved = await changed(
      `DELETE FROM kortix.role_assignments old USING kortix.role_assignments newer
       WHERE old.principal_type='user' AND old.principal_id=$1::uuid
         AND newer.account_id=old.account_id AND newer.principal_type=old.principal_type AND newer.principal_id=$2::uuid
         AND newer.role_id=old.role_id AND newer.scope_type=old.scope_type
         AND newer.scope_id IS NOT DISTINCT FROM old.scope_id
         AND newer.object_type IS NOT DISTINCT FROM old.object_type
         AND newer.object_id IS NOT DISTINCT FROM old.object_id`, [oldId, newId],
    );
    const rolesMoved = await changed(
      "UPDATE kortix.role_assignments SET principal_id=$2::uuid,updated_at=now() WHERE principal_type='user' AND principal_id=$1::uuid", [oldId, newId],
    );
    const grantsMoved = await changed(
      "UPDATE kortix.project_session_grants SET principal_id=$2::uuid WHERE principal_type='member' AND principal_id=$1::uuid", [oldId, newId],
    );
    const sessionsMoved = await changed('UPDATE kortix.project_sessions SET created_by=$2::uuid WHERE created_by=$1::uuid', [oldId, newId]);
    const tokensMoved = await changed('UPDATE kortix.account_tokens SET user_id=$2::uuid WHERE user_id=$1::uuid AND session_id IS NOT NULL', [oldId, newId]);
    const basejumpMemberships = await changed(
      `INSERT INTO basejump.account_user (user_id,account_id,account_role)
       SELECT $2::uuid,account_id,account_role FROM basejump.account_user WHERE user_id=$1::uuid
       ON CONFLICT DO NOTHING`, [oldId, newId],
    );
    await changed('DELETE FROM basejump.account_user WHERE user_id=$1::uuid', [oldId]);
    const personalOwnersMoved = await changed('UPDATE basejump.accounts SET primary_owner_user_id=$2::uuid WHERE primary_owner_user_id=$1::uuid', [oldId, newId]);
    const githubStatesMoved = await changed('UPDATE kortix.account_github_installation_states SET user_id=$2::uuid WHERE user_id=$1::uuid', [oldId, newId]);
    if (sessionsMoved !== before.sessions || grantsMoved !== before.session_grants || tokensMoved !== before.session_tokens || membershipsRemoved !== before.memberships || scimRebound !== before.scim_records || rolesMoved + duplicateRolesRemoved !== before.roles || groupsRemoved !== before.groups) {
      throw Error(`Row-count drift for ${email}`);
    }
    if (revokedAlready && membershipInserted !== 0) throw Error(`Revoked account access restored for ${email}`);
    results.push({ email, old_id: oldId, new_id: newId, before, changed: { membershipInserted, scimRebound, groupsInserted, groupsRemoved, duplicateRolesRemoved, rolesMoved, grantsMoved, sessionsMoved, tokensMoved, basejumpMemberships, personalOwnersMoved, githubStatesMoved } });
  }
  if (apply) await client.query('COMMIT');
  else await client.query('ROLLBACK');
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'rolled_back', pairs: results }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
