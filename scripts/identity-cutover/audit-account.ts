/** Read-only account-wide audit of directory identities and session owners. */
import { Client } from 'pg';

const accountId = process.argv.find(arg => arg.startsWith('--account='))?.slice(10);
if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) throw Error('Pass --account=<uuid>');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');

const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'identity-directory-audit' });
await client.connect();
try {
  const account = await client.query(`
      SELECT
        (SELECT count(*) FROM kortix.project_sessions WHERE account_id=$1)::int sessions,
        (SELECT count(DISTINCT created_by) FROM kortix.project_sessions WHERE account_id=$1 AND created_by IS NOT NULL)::int session_owners,
        (SELECT count(*) FROM kortix.account_scim_users WHERE account_id=$1)::int directory_total,
        (SELECT count(*) FROM kortix.account_scim_users WHERE account_id=$1 AND active AND deleted_at IS NULL)::int directory_active
    `, [accountId]);
  const classifications = await client.query(`
      WITH owners AS (
        SELECT s.created_by user_id, lower(u.email) email, u.is_sso_user, count(*)::int sessions
        FROM kortix.project_sessions s JOIN auth.users u ON u.id=s.created_by
        WHERE s.account_id=$1 GROUP BY s.created_by, lower(u.email), u.is_sso_user
      ), classified AS (
        SELECT o.*, d.active AND d.deleted_at IS NULL directory_active, d.scim_id IS NOT NULL has_directory
        FROM owners o LEFT JOIN kortix.account_scim_users d ON d.account_id=$1 AND lower(d.user_name)=o.email
      )
      SELECT CASE
        WHEN is_sso_user AND directory_active THEN 'active_directory_sso'
        WHEN NOT is_sso_user AND directory_active THEN 'active_directory_legacy_auth'
        WHEN is_sso_user AND has_directory THEN 'inactive_directory_sso'
        WHEN has_directory THEN 'inactive_directory_legacy_auth'
        ELSE 'no_directory_record'
      END class, count(*)::int owners, sum(sessions)::int sessions
      FROM classified GROUP BY 1 ORDER BY 1
    `, [accountId]);
  const mismatches = await client.query(`
      SELECT d.user_name, d.user_id directory_user_id, owner.id owner_id, count(s.session_id)::int sessions
      FROM kortix.account_scim_users d
      JOIN auth.users owner ON lower(owner.email)=lower(d.user_name)
      JOIN kortix.project_sessions s ON s.account_id=d.account_id AND s.created_by=owner.id
      WHERE d.account_id=$1 AND d.user_id IS NOT NULL AND owner.id<>d.user_id
      GROUP BY d.user_name, d.user_id, owner.id ORDER BY sessions DESC
    `, [accountId]);
  const duplicates = await client.query(`
      SELECT lower(u.email) email, count(*)::int memberships
      FROM kortix.account_memberships m JOIN auth.users u ON u.id=m.user_id
      WHERE m.account_id=$1 GROUP BY lower(u.email) HAVING count(*)>1 ORDER BY email
    `, [accountId]);
  const pending = await client.query(`
      SELECT d.user_name, d.invitation_id
      FROM kortix.account_scim_users d
      WHERE d.account_id=$1 AND d.active AND d.deleted_at IS NULL AND d.user_id IS NULL
      ORDER BY d.user_name
    `, [accountId]);
  const ownerAuthShape = await client.query(`
    WITH owner_emails AS (
      SELECT DISTINCT lower(u.email) email
      FROM kortix.project_sessions s JOIN auth.users u ON u.id=s.created_by
      WHERE s.account_id=$1
    ), counts AS (
      SELECT owner_emails.email, count(u.id)::int auth_ids,
             count(*) FILTER (WHERE u.is_sso_user)::int sso_ids
      FROM owner_emails JOIN auth.users u ON lower(u.email)=owner_emails.email
      GROUP BY owner_emails.email
    )
    SELECT count(*)::int owner_emails,
           count(*) FILTER (WHERE auth_ids=1)::int single_auth_id,
           count(*) FILTER (WHERE auth_ids>1)::int multiple_auth_ids,
           count(*) FILTER (WHERE sso_ids>0)::int with_sso_id
    FROM counts
  `, [accountId]);
  const output = {
    account_id: accountId,
    ...account.rows[0],
    classifications: classifications.rows,
    owner_auth_shape: ownerAuthShape.rows[0],
    mismatched_session_owners: mismatches.rows,
    duplicate_membership_emails: duplicates.rows,
    pending_directory_users: pending.rows,
  };
  console.log(JSON.stringify(output, null, 2));
  if (mismatches.rowCount || duplicates.rowCount) process.exitCode = 1;
} finally {
  await client.end();
}
