import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { invalidateIamCacheForUser } from './cache-invalidation';

export interface AccountIdentityResolution {
  userId: string | null;
  ambiguous: boolean;
}

/**
 * Resolve the one Auth UUID that represents an email inside an account.
 * The account's configured SSO provider wins, then its active directory link,
 * then an existing account membership. Equal-priority duplicates fail closed.
 */
export async function resolveAccountIdentityByEmail(
  accountId: string,
  email: string,
): Promise<AccountIdentityResolution> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return { userId: null, ambiguous: false };

  const rows = (await db.execute(sql`
    WITH candidates AS (
      SELECT u.id::text AS user_id,
        CASE
          WHEN provider.supabase_sso_provider_id IS NOT NULL AND (
            u.raw_app_meta_data->>'provider'='sso:' || provider.supabase_sso_provider_id::text
            OR coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb)
              ? ('sso:' || provider.supabase_sso_provider_id::text)
          ) THEN 0
          WHEN directory.user_id=u.id AND directory.active AND directory.deleted_at IS NULL THEN 1
          WHEN membership.user_id=u.id THEN 2
          ELSE 3
        END AS priority
      FROM auth.users u
      LEFT JOIN kortix.account_sso_providers provider
        ON provider.account_id=${accountId}::uuid
      LEFT JOIN kortix.account_scim_users directory
        ON directory.account_id=${accountId}::uuid
        AND lower(trim(directory.user_name))=${normalizedEmail}
      LEFT JOIN kortix.account_memberships membership
        ON membership.account_id=${accountId}::uuid AND membership.user_id=u.id
      WHERE lower(trim(u.email))=${normalizedEmail}
    ), best AS (
      SELECT min(priority) AS priority FROM candidates
    )
    SELECT candidates.user_id
    FROM candidates, best
    WHERE candidates.priority=best.priority
    ORDER BY candidates.user_id
  `)) as unknown as Array<{ user_id: string }>;
  if (rows.length === 0) return { userId: null, ambiguous: false };
  if (rows.length > 1) return { userId: null, ambiguous: true };
  return { userId: rows[0]?.user_id ?? null, ambiguous: false };
}

async function transferProviderConnections(
  sourceUserId: string,
  targetUserId: string,
  accountId: string,
): Promise<void> {
  const sourceConnections = (await db.execute(sql`
    SELECT DISTINCT connection.connection_id::text, connection.provider_id, connection.slot
    FROM kortix.user_provider_connections connection
    WHERE connection.user_id=${sourceUserId}::uuid
      AND (
        EXISTS (
          SELECT 1
          FROM kortix.project_user_provider_connections binding
          JOIN kortix.projects project_row ON project_row.project_id=binding.project_id
          WHERE binding.connection_id=connection.connection_id
            AND binding.user_id=${sourceUserId}::uuid
            AND project_row.account_id=${accountId}::uuid
        )
        OR EXISTS (
          SELECT 1
          FROM kortix.session_user_provider_connections binding
          JOIN kortix.project_sessions session_row ON session_row.session_id=binding.session_id
          WHERE binding.connection_id=connection.connection_id
            AND binding.user_id=${sourceUserId}::uuid
            AND session_row.account_id=${accountId}::uuid
        )
      )
  `)) as unknown as Array<{ connection_id: string; provider_id: string; slot: string }>;

  for (const source of sourceConnections) {
    const [existing] = (await db.execute(sql`
      SELECT connection_id::text
      FROM kortix.user_provider_connections
      WHERE user_id=${targetUserId}::uuid
        AND provider_id=${source.provider_id}
        AND slot=${source.slot}
      LIMIT 1
    `)) as unknown as Array<{ connection_id: string }>;
    const targetConnectionId = existing?.connection_id ?? crypto.randomUUID();
    if (!existing) {
      await db.execute(sql`
        INSERT INTO kortix.user_provider_connections
          (connection_id, user_id, provider_id, auth_type, slot, label, value_enc, created_at, updated_at)
        SELECT ${targetConnectionId}::uuid, ${targetUserId}::uuid, provider_id, auth_type,
          slot, label, value_enc, created_at, updated_at
        FROM kortix.user_provider_connections
        WHERE connection_id=${source.connection_id}::uuid AND user_id=${sourceUserId}::uuid
      `);
    }
    await db.execute(sql`
      INSERT INTO kortix.project_user_provider_connections
        (project_id, user_id, provider_id, connection_id, pool, created_at)
      SELECT project_id, ${targetUserId}::uuid, provider_id, ${targetConnectionId}::uuid, pool, created_at
      FROM kortix.project_user_provider_connections binding
      WHERE binding.connection_id=${source.connection_id}::uuid
        AND binding.user_id=${sourceUserId}::uuid
        AND EXISTS (
          SELECT 1 FROM kortix.projects project_row
          WHERE project_row.project_id=binding.project_id
            AND project_row.account_id=${accountId}::uuid
        )
      ON CONFLICT (project_id, user_id, provider_id) DO UPDATE SET
        pool=kortix.project_user_provider_connections.pool OR excluded.pool
    `);
    await db.execute(sql`
      INSERT INTO kortix.session_user_provider_connections
        (session_id, user_id, provider_id, connection_id)
      SELECT session_id, ${targetUserId}::uuid, provider_id, ${targetConnectionId}::uuid
      FROM kortix.session_user_provider_connections binding
      WHERE binding.connection_id=${source.connection_id}::uuid
        AND binding.user_id=${sourceUserId}::uuid
        AND EXISTS (
          SELECT 1 FROM kortix.project_sessions session_row
          WHERE session_row.session_id=binding.session_id
            AND session_row.account_id=${accountId}::uuid
        )
      ON CONFLICT (session_id, user_id, provider_id) DO NOTHING
    `);
    await db.execute(sql`
      DELETE FROM kortix.project_user_provider_connections binding
      WHERE binding.connection_id=${source.connection_id}::uuid
        AND binding.user_id=${sourceUserId}::uuid
        AND EXISTS (
          SELECT 1 FROM kortix.projects project_row
          WHERE project_row.project_id=binding.project_id
            AND project_row.account_id=${accountId}::uuid
        )
    `);
    await db.execute(sql`
      DELETE FROM kortix.session_user_provider_connections binding
      WHERE binding.connection_id=${source.connection_id}::uuid
        AND binding.user_id=${sourceUserId}::uuid
        AND EXISTS (
          SELECT 1 FROM kortix.project_sessions session_row
          WHERE session_row.session_id=binding.session_id
            AND session_row.account_id=${accountId}::uuid
        )
    `);
  }
}

async function reconcileOneAccountIdentity(
  accountId: string,
  sourceUserId: string,
  targetUserId: string,
): Promise<void> {
  if (sourceUserId === targetUserId) return;

  // Establish the target membership first. Several active grant tables have a
  // composite FK to it and must be copied before the source membership leaves.
  await db.execute(sql`
    INSERT INTO kortix.account_memberships
      (user_id, account_id, joined_at, is_super_admin, scim_external_id)
    SELECT ${targetUserId}::uuid, account_id, joined_at, is_super_admin, scim_external_id
    FROM kortix.account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
    ON CONFLICT (user_id, account_id) DO UPDATE SET
      joined_at=least(kortix.account_memberships.joined_at, excluded.joined_at),
      is_super_admin=kortix.account_memberships.is_super_admin OR excluded.is_super_admin,
      scim_external_id=coalesce(excluded.scim_external_id, kortix.account_memberships.scim_external_id)
  `);
  await db.execute(sql`
    INSERT INTO kortix.account_secret_grants (secret_id, account_id, user_id, granted_by, created_at)
    SELECT secret_id, account_id, ${targetUserId}::uuid, granted_by, created_at
    FROM kortix.account_secret_grants
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
    ON CONFLICT (secret_id, user_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.account_secret_grants
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO kortix.account_group_members (group_id, user_id, added_by, added_at)
    SELECT member.group_id, ${targetUserId}::uuid, member.added_by, member.added_at
    FROM kortix.account_group_members member
    JOIN kortix.account_groups group_row ON group_row.group_id=member.group_id
    WHERE group_row.account_id=${accountId}::uuid AND member.user_id=${sourceUserId}::uuid
    ON CONFLICT (group_id, user_id) DO NOTHING
  `);

  await db.execute(sql`
    DELETE FROM kortix.role_assignments old USING kortix.role_assignments newer
    WHERE old.account_id=${accountId}::uuid
      AND old.principal_type='user' AND old.principal_id=${sourceUserId}::uuid
      AND newer.account_id=old.account_id AND newer.principal_type='user'
      AND newer.principal_id=${targetUserId}::uuid AND newer.role_id=old.role_id
      AND newer.scope_type=old.scope_type AND newer.scope_id IS NOT DISTINCT FROM old.scope_id
      AND newer.object_type IS NOT DISTINCT FROM old.object_type
      AND newer.object_id IS NOT DISTINCT FROM old.object_id
  `);
  await db.execute(sql`
    UPDATE kortix.role_assignments SET principal_id=${targetUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND principal_type='user' AND principal_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.iam_policies SET principal_id=${targetUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND principal_type='member' AND principal_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO kortix.iam_resource_grants
      (grant_id, account_id, project_id, resource_type, resource_id, principal_type,
       principal_id, effect, expires_at, granted_by, created_at, updated_at)
    SELECT gen_random_uuid(), account_id, project_id, resource_type, resource_id, principal_type,
      ${targetUserId}::uuid, effect, expires_at, granted_by, created_at, updated_at
    FROM kortix.iam_resource_grants
    WHERE account_id=${accountId}::uuid AND principal_type='member' AND principal_id=${sourceUserId}::uuid
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.iam_resource_grants
    WHERE account_id=${accountId}::uuid AND principal_type='member' AND principal_id=${sourceUserId}::uuid
  `);

  await db.execute(sql`
    INSERT INTO kortix.project_session_grants (session_id, principal_type, principal_id, created_at)
    SELECT grant_row.session_id, grant_row.principal_type, ${targetUserId}::uuid, grant_row.created_at
    FROM kortix.project_session_grants grant_row
    JOIN kortix.project_sessions session_row ON session_row.session_id=grant_row.session_id
    WHERE session_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
    ON CONFLICT (session_id, principal_type, principal_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.project_session_grants grant_row USING kortix.project_sessions session_row
    WHERE session_row.session_id=grant_row.session_id AND session_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO kortix.project_trigger_session_access_grants
      (grant_id, project_id, slug, principal_type, principal_id, created_at)
    SELECT gen_random_uuid(), grant_row.project_id, grant_row.slug, grant_row.principal_type,
      ${targetUserId}::uuid, grant_row.created_at
    FROM kortix.project_trigger_session_access_grants grant_row
    JOIN kortix.projects project_row ON project_row.project_id=grant_row.project_id
    WHERE project_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
    ON CONFLICT (project_id, slug, principal_type, principal_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.project_trigger_session_access_grants grant_row USING kortix.projects project_row
    WHERE project_row.project_id=grant_row.project_id AND project_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO kortix.app_access_grants (grant_id, app_id, principal_type, principal_id, created_at)
    SELECT gen_random_uuid(), grant_row.app_id, grant_row.principal_type, ${targetUserId}::uuid, grant_row.created_at
    FROM kortix.app_access_grants grant_row
    JOIN kortix.apps app_row ON app_row.app_id=grant_row.app_id
    WHERE app_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
    ON CONFLICT (app_id, principal_type, principal_id) DO NOTHING
  `);
  await db.execute(sql`
    DELETE FROM kortix.app_access_grants grant_row USING kortix.apps app_row
    WHERE app_row.app_id=grant_row.app_id AND app_row.account_id=${accountId}::uuid
      AND grant_row.principal_type='member' AND grant_row.principal_id=${sourceUserId}::uuid
  `);

  // Move active ownership. Historical actor/creator columns remain unchanged.
  await db.execute(sql`
    UPDATE kortix.project_sessions SET created_by=${targetUserId}::uuid
    WHERE account_id=${accountId}::uuid AND created_by=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.project_trigger_runtime runtime SET owner_user_id=${targetUserId}::uuid, updated_at=now()
    FROM kortix.projects project_row
    WHERE project_row.project_id=runtime.project_id AND project_row.account_id=${accountId}::uuid
      AND runtime.owner_user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    DELETE FROM kortix.project_secrets source USING kortix.project_secrets target, kortix.projects project_row
    WHERE project_row.project_id=source.project_id AND project_row.account_id=${accountId}::uuid
      AND source.owner_user_id=${sourceUserId}::uuid
      AND target.project_id=source.project_id AND target.name=source.name
      AND target.owner_user_id=${targetUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.project_secrets secret_row SET owner_user_id=${targetUserId}::uuid, updated_at=now()
    FROM kortix.projects project_row
    WHERE project_row.project_id=secret_row.project_id AND project_row.account_id=${accountId}::uuid
      AND secret_row.owner_user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.gateway_budgets budget SET subject_user_id=${targetUserId}::uuid, updated_at=now()
    FROM kortix.projects project_row
    WHERE project_row.project_id=budget.project_id AND project_row.account_id=${accountId}::uuid
      AND budget.scope='member' AND budget.subject_user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.prompt_attachments SET user_id=${targetUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.connector_attachments SET user_id=${targetUserId}::uuid
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid AND consumed_at IS NULL
  `);
  await db.execute(sql`
    UPDATE kortix.chat_thread_participants participant SET user_id=${targetUserId}::uuid, updated_at=now()
    FROM kortix.project_sessions session_row
    WHERE session_row.session_id=participant.session_id AND session_row.account_id=${accountId}::uuid
      AND participant.user_id=${sourceUserId}::uuid
  `);

  await transferProviderConnections(sourceUserId, targetUserId, accountId);
  await db.execute(sql`
    UPDATE kortix.connection_credentials credential SET user_id=${targetUserId}::uuid, updated_at=now()
    FROM kortix.connectors connector_row
    WHERE connector_row.connector_id=credential.connector_id
      AND connector_row.account_id=${accountId}::uuid
      AND credential.user_id=${sourceUserId}::uuid
  `);

  // Login credentials never silently change owners. Session-bound tokens follow
  // their transferred sessions; standalone and OAuth credentials are revoked.
  await db.execute(sql`
    UPDATE kortix.account_tokens SET status='revoked', revoked_at=coalesce(revoked_at, now())
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
      AND session_id IS NULL AND status='active'
  `);
  await db.execute(sql`
    UPDATE kortix.account_tokens SET user_id=${targetUserId}::uuid
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid AND session_id IS NOT NULL
  `);
  await db.execute(sql`
    UPDATE kortix.oauth_access_tokens SET revoked_at=coalesce(revoked_at, now())
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.oauth_refresh_tokens SET revoked_at=coalesce(revoked_at, now())
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    DELETE FROM kortix.oauth_authorization_codes
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid AND used_at IS NULL
  `);
  await db.execute(sql`
    UPDATE kortix.yolo_member_tokens SET revoked_at=coalesce(revoked_at, now())
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid AND revoked_at IS NULL
  `);
  await db.execute(sql`
    UPDATE kortix.account_session_activity
    SET revoked_at=coalesce(revoked_at, now()), revoked_reason=coalesce(revoked_reason, 'identity_reconciled')
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);

  await db.execute(sql`
    UPDATE kortix.account_github_installation_states SET user_id=${targetUserId}::uuid
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    UPDATE kortix.account_scim_users SET user_id=${targetUserId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);

  await db.execute(sql`
    DELETE FROM kortix.account_group_members member USING kortix.account_groups group_row
    WHERE group_row.group_id=member.group_id AND group_row.account_id=${accountId}::uuid
      AND member.user_id=${sourceUserId}::uuid
  `);
  await db.execute(sql`
    DELETE FROM kortix.account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=${sourceUserId}::uuid
  `);
  invalidateIamCacheForUser(sourceUserId);
}

/**
 * Merge every prior account-scoped Auth UUID into one canonical Auth UUID.
 * Call this inside withDirectoryTransaction(accountId, ...).
 */
export async function reconcileAccountIdentities(
  accountId: string,
  sourceUserIds: readonly string[],
  targetUserId: string,
): Promise<void> {
  for (const sourceUserId of new Set(sourceUserIds)) {
    await reconcileOneAccountIdentity(accountId, sourceUserId, targetUserId);
  }
  invalidateIamCacheForUser(targetUserId);
}
