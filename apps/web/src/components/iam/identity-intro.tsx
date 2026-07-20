'use client';

import { useQuery } from '@tanstack/react-query';

import { getSsoProvider, listScimTokens } from '@/lib/iam-client';

/**
 * "Why connect both?" onboarding explainer for the Identity tab. Educational
 * copy is for FIRST contact — once either SSO or Directory Sync is set up the
 * admin knows what these are, and the block is just noise above the fold, so
 * it renders only while BOTH are unconfigured. Uses the same query keys as
 * SsoCard/ScimCard (React Query dedupes → no extra round-trips).
 */
export function IdentityIntro({ accountId }: { accountId: string }) {
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
  if (providerQuery.data || (tokensQuery.data ?? []).length > 0) return null;

  return (
    <div className="border-border/60 bg-muted/20 space-y-1.5 rounded-md border px-4 py-3">
      <p className="text-foreground text-xs font-medium">Why connect both?</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        <span className="text-foreground font-medium">SAML SSO</span> is how people sign in — with
        your identity provider's own credentials and MFA, never a Kortix password.{' '}
        <span className="text-foreground font-medium">SCIM directory sync</span> is who exists — it
        keeps your Kortix roster matched to your IdP and automatically removes access the moment
        someone leaves. Most enterprises want both; set up SSO first, then Directory Sync.
      </p>
    </div>
  );
}
