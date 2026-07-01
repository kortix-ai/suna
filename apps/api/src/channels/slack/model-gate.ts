import { and, eq } from 'drizzle-orm';
import { accountMembers, projects } from '@kortix/db';
import { sharedConfig as config, sharedDb as db } from '../../shared/effect';
import { getAccountTier } from '../../billing/services/entitlements';
import { tierGrantsAllModels } from '../../billing/services/tiers';
import { type ChannelCtx, currentChannelSelection } from './selection';

// The account/tier context a channel's model setting resolves against. Kept out
// of selection.ts (which is intentionally lightweight: just db + git) because it
// pulls in config + billing — so the per-channel binding helpers stay cheap to
// unit-test in isolation.

export interface ChannelModelContext {
  projectId: string;
  accountId: string;
  /** A representative project-owner user (for codex credential lookups). */
  ownerUserId: string;
  /** The account may not use platform-managed Kortix models. */
  freeManagedOnly: boolean;
}

/**
 * Resolve the project + owner account + tier a channel's model decisions key off.
 * Used to validate a model (isModelServableForAccount) and to list the real
 * picker catalog (listPickerModels). Null when the channel is unbound.
 */
export async function channelModelContext(ctx: ChannelCtx): Promise<ChannelModelContext | null> {
  const selection = await currentChannelSelection(ctx);
  if (!selection?.projectId) return null;
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, selection.projectId))
    .limit(1);
  if (!project) return null;
  const [owner] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, project.accountId), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  const tier = await getAccountTier(project.accountId);
  const freeManagedOnly = config.KORTIX_BILLING_INTERNAL_ENABLED && !tierGrantsAllModels(tier);
  return {
    projectId: selection.projectId,
    accountId: project.accountId,
    ownerUserId: owner?.userId ?? project.accountId,
    freeManagedOnly,
  };
}
