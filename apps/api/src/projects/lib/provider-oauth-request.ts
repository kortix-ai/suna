import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from '@hono/zod-openapi';
import { accountSecretResources } from '@kortix/db';
import { parseSharingIntent } from '../../connectors/share';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { accountMemberRow } from '../../iam/membership-read';
import { memberMayReadProject } from '../../secrets/account-resource';
import { db } from '../../shared/db';
import type { loadProjectForUser } from './access';

/** What the start request asked for, once validated. */
export interface OAuthStartRequest {
  resourceLabel: string | null;
  resourceId: string | null;
  sharing: ReturnType<typeof parseSharingIntent> | undefined;
}

/**
 * Validates the `/oauth/:provider/start` body for a loaded project: the named
 * resource label, the reconnect `resource_id`, the pooled flag, member
 * ownership and the sharing intent. Returns the parsed request, or the 400/403/404
 * response to send.
 */
export async function parseOAuthStartRequest(
  c: Context,
  body: Record<string, unknown>,
  cfg: { label: string; resourceProviderId: string; secretName: string },
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
  projectId: string,
): Promise<{ request: OAuthStartRequest } | { response: Response }> {
  const resourceLabel = body.resource_label === undefined ? null :
    typeof body.resource_label === 'string' ? body.resource_label.trim() : '';
  if (resourceLabel !== null && (resourceLabel.length < 1 || resourceLabel.length > 100)) {
    return { response: c.json({ error: 'A named OAuth resource requires a 1–100 character label' }, 400) };
  }
  // Reconnect refreshes the login of an existing named account resource in
  // place. It never renames or re-shares it, so a label or sharing is refused.
  const resourceId = body.resource_id === undefined ? null :
    typeof body.resource_id === 'string' ? body.resource_id.trim() : '';
  if (resourceId !== null && !z.string().uuid().safeParse(resourceId).success) {
    return { response: c.json({ error: `resource_id must be the id of a ${cfg.label} account` }, 400) };
  }
  if (resourceId !== null && (resourceLabel !== null || body.sharing != null)) {
    return { response: c.json({ error: 'Reconnecting keeps the account label and access; send only resource_id' }, 400) };
  }
  const named = resourceLabel !== null || resourceId !== null;
  if (named && !resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets')) {
    return { response: c.json({ error: 'Pooled OAuth connections require pooled provider secrets' }, 403) };
  }
  if (named) {
    const [member] = await accountMemberRow(loaded.row.accountId, loaded.userId);
    if (!member) return { response: c.json({ error: `An account member must own a ${cfg.label} connection` }, 403) };
  }
  if (resourceId !== null) {
    const [resource] = await db.select({
      projectId: accountSecretResources.projectId,
      providerId: accountSecretResources.providerId,
      name: accountSecretResources.name,
      createdBy: accountSecretResources.createdBy,
    }).from(accountSecretResources)
      .where(and(eq(accountSecretResources.accountId, loaded.row.accountId), eq(accountSecretResources.secretId, resourceId)))
      .limit(1);
    if (!resource || resource.projectId !== projectId || resource.providerId !== cfg.resourceProviderId ||
      resource.name !== cfg.secretName) {
      return { response: c.json({ error: `${cfg.label} account not found` }, 404) };
    }
    // The login is the owner's own subscription; only they re-authorize it.
    // Account admins can still delete the account.
    if (resource.createdBy !== loaded.userId) {
      return { response: c.json({ error: `Only the person who connected this ${cfg.label} account can reconnect it` }, 403) };
    }
  }

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return { response: c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400) };
    }
    if (resourceLabel !== null) {
      if (sharing.mode === 'private' && sharing.ownerId !== loaded.userId) return { response: c.json({ error: 'Invalid connection owner' }, 400) };
      if (sharing.mode === 'members') {
        if (sharing.groupIds?.length || (sharing.memberIds?.length ?? 0) > 200) return { response: c.json({ error: 'Select up to 200 workspace members' }, 400) };
        for (const userId of sharing.memberIds ?? []) {
          if (!z.string().uuid().safeParse(userId).success || !(await memberMayReadProject(loaded.row.accountId, projectId, userId))) {
            return { response: c.json({ error: 'Member has no project access' }, 400) };
          }
        }
      }
    }
  }
  return { request: { resourceLabel, resourceId, sharing } };
}
