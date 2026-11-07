'use client';

/**
 * The one line that says why a Free workspace has no free credits.
 *
 * The Free plan's monthly credits go to a person's first workspace only
 * (Workspaces, design.md §3.2 C6). A further workspace starts on Free with 0
 * credits; `credits.free_grant.eligible` is false there. Without this line the
 * workspace reads "Free · Active · 0 credits" and the person learns why only
 * when a session is refused (review finding 10).
 *
 * The workspace that holds the person's free credits is named when the API
 * reports it (`claimed_workspace_id`, set only for a member of it) and its
 * record is readable. Otherwise the line states the rule.
 */
import { type AccountState } from '@kortix/sdk';
import { useWorkspace } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';

import { useTranslations } from '@/i18n/use-translations';

/** True when the line applies: Free, no subscription, no comp, not eligible. */
export function showsFreeGrantNotice(state: AccountState | null | undefined): boolean {
  if (!state) return false;
  if (state.credits?.free_grant?.eligible !== false) return false;
  if (state.plan_comp) return false;
  if (state.has_active_subscription) return false;
  return (state.plan?.family ?? 'free') === 'free';
}

export function FreeGrantNotice({ state, className }: { state: AccountState | null | undefined; className?: string }) {
  if (!showsFreeGrantNotice(state)) return null;
  const claimedId = state?.credits?.free_grant?.claimed_workspace_id ?? null;
  // The workspace read needs a query client: only a line that names a
  // workspace mounts it, so a presentational view of any other plan does not.
  return claimedId ? <NamedFreeGrantLine workspaceId={claimedId} className={className} /> : <FreeGrantLine className={className} />;
}

function NamedFreeGrantLine({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const claimed = useWorkspace(workspaceId);
  return <FreeGrantLine name={claimed.data?.name?.trim() || null} className={className} />;
}

function FreeGrantLine({ name, className }: { name?: string | null; className?: string }) {
  const t = useTranslations('billing.freeGrant');
  return (
    <p className={cn('text-muted-foreground text-xs text-pretty', className)} data-testid="free-grant-notice">
      {name ? t('elsewhere', { workspace: name }) : t('firstOnly')} {t('action')}
    </p>
  );
}
