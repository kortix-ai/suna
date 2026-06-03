'use client';

import { useTranslations } from 'next-intl';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, KeyRound } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { accountTokensApi } from '@/lib/api/account-tokens';
import { getAccount } from '@/lib/projects-client';

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function TokenDetailPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const params = useParams<{ id: string; tokenId: string }>();
  const accountId = params?.id;
  const tokenId = params?.tokenId;
  const { user, isLoading: authLoading } = useAuth();

  // The list endpoint already returns every token for the account — cheaper
  // than a per-token GET and reuses any prior fetch. The token's secret
  // never leaves the server side after creation, so listing is the only
  // way to know about a token's metadata anyway.
  const tokensQuery = useQuery({
    queryKey: ['account-tokens', accountId],
    queryFn: () => accountTokensApi.list(),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const token = useMemo(
    () => tokensQuery.data?.find((t) => t.token_id === tokenId),
    [tokensQuery.data, tokenId],
  );

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => router.push('/projects')}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdTokensTokenidPage.line78JsxTextBackToProjects')}</button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/accounts')}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                Accounts
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button
                type="button"
                onClick={() => router.push(`/accounts/${accountId}`)}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                {accountQuery.data?.name ?? 'Account'}
              </button>
              <span className="text-muted-foreground/40">/</span>
              <span>{tHardcodedUi.raw('appAccountsIdTokensTokenidPage.line97JsxTextCliTokens')}</span>
              <span className="text-muted-foreground/40">/</span>
              {tokensQuery.isLoading ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span className="truncate font-medium text-foreground">
                  {token?.name ?? 'Token'}
                </span>
              )}
            </div>
            <div className="flex items-start gap-3">
              <EntityAvatar icon={KeyRound} size="lg" />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  {tokensQuery.isLoading ? (
                    <Skeleton className="h-7 w-48" />
                  ) : (
                    token?.name ?? 'Token not found'
                  )}
                </h1>
                {token && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge
                      variant={token.status === 'active' ? 'outline' : 'destructive'}
                      size="sm"
                      className="font-normal capitalize"
                    >
                      {token.status}
                    </Badge>
                    <span>Created {formatDate(token.created_at)}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span>{tHardcodedUi.raw('appAccountsIdTokensTokenidPage.line128JsxTextLastUsed')}{' '}{formatDate(token.last_used_at)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {!tokensQuery.isLoading && !token && tokenId && (
            <InfoBanner tone="neutral">{tHardcodedUi.raw('appAccountsIdTokensTokenidPage.line137JsxTextThisTokenDoesnAposTExistOrHas')}</InfoBanner>
          )}

          {token && accountId && (
            <InfoBanner tone="info" title="Token permissions">
              Tokens inherit their creator&apos;s account-role and group memberships at request time. To narrow what a token can reach, scope it to a single project when minting.
            </InfoBanner>
          )}
        </div>
      </main>
    </div>
  );
}
