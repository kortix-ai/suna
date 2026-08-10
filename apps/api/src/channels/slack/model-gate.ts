import { and, eq } from 'drizzle-orm';
import { accountMembers, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { getAccountTier } from '../../billing/services/entitlements';
import { accountIsFreeTierForModels } from '../../billing/services/tiers';
import { type ChannelCtx, currentChannelSelection } from './selection';

// The account/tier context a channel's model setting resolves against. Kept out
// of selection.ts (which is intentionally lightweight: just db + git) because it
// pulls in config + billing — so the per-channel binding helpers stay cheap to
// unit-test in isolation.

export interface ChannelModelContext {
  workspaceId: string;
  accountId: string;
  /** A representative workspace-owner user for Codex credential lookups. */
  ownerUserId: string;
  /** The account may not use platform-managed Kortix models. */
  freeManagedOnly: boolean;
}

/**
 * Resolve the workspace + owner account + tier a channel's model decisions key off.
 * Used to validate a model (isModelServableForAccount) and to list the real
 * picker catalog (listPickerModels). Null when the channel is unbound.
 */
export async function channelModelContext(ctx: ChannelCtx): Promise<ChannelModelContext | null> {
  const selection = await currentChannelSelection(ctx);
  if (!selection?.workspaceId) return null;
  const [workspace] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.workspaceId, selection.workspaceId))
    .limit(1);
  if (!workspace) return null;
  const [owner] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, workspace.accountId), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  const tier = await getAccountTier(workspace.accountId);
  const freeManagedOnly = config.KORTIX_BILLING_INTERNAL_ENABLED && accountIsFreeTierForModels(tier);
  return {
    workspaceId: selection.workspaceId,
    accountId: workspace.accountId,
    ownerUserId: owner?.userId ?? workspace.accountId,
    freeManagedOnly,
  };
}
