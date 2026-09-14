'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

import { getSsoProvider, listScimTokens } from '@/lib/iam-client';

/**
 * "Why connect both?" onboarding explainer for the Identity tab. Educational
 * copy is for FIRST contact — once either SSO or Directory Sync is set up the
 * admin knows what these are, and the block is just noise above the fold, so
 * it renders only while BOTH are unconfigured. Uses the same query keys as
 * SsoCard/ScimCard (React Query dedupes → no extra round-trips).
 */
export function IdentityIntro({ accountId }: { accountId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const providerQuery = useQuery({
    queryKey: ['iam-sso-provider', accountId],
    queryFn: () => getSsoProvider(accountId),
    staleTime: 30_000,
  });
  const tokensQuery = useQuery({
    queryKey: ['scim-tokens', accountId],
    queryFn: () => listScimTokens(accountId),
    staleTime: 30_000,
  });

  // While loading, render nothing — a flash-in/flash-out explainer is worse
  // than none. Configured accounts (either surface) skip it entirely.
  if (providerQuery.isLoading || tokensQuery.isLoading) return null;
  // A failed fetch is NOT "nothing is configured": rendering the first-contact
  // explainer above two cards that are themselves showing an error state reads
  // as if the account were unconfigured. Stay hidden until we actually know.
  if (providerQuery.isError || tokensQuery.isError) return null;
  if (providerQuery.data || (tokensQuery.data ?? []).length > 0) return null;

  return (
    <div className="border-border/60 bg-muted/20 space-y-1.5 rounded-md border px-4 py-3">
      <p className="text-foreground text-xs font-medium">{tI18nComplete.raw('texta731e5385a6a')}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        <span className="text-foreground font-medium">{tI18nComplete.raw('text405e739d53d2')}</span>{' '}
        {tI18nComplete.raw('text455af11c8046')}{' '}
        <span className="text-foreground font-medium">{tI18nComplete.raw('text0835965ba94e')}</span>{' '}
        {tI18nComplete.raw('text3999be1cc89e')}
      </p>
    </div>
  );
}
