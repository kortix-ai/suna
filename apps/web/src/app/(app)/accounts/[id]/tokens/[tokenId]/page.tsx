'use client';

import { useTranslations } from 'next-intl';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import { accountTokensApi } from '@/lib/api/account-tokens';
import { usePermission } from '@/lib/use-permission';

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function TokenDetailPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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

  const token = useMemo(
    () => tokensQuery.data?.find((t) => t.token_id === tokenId),
    [tokensQuery.data, tokenId],
  );

  // policy.create gates the "Create / Edit / Remove" affordances inside the
  // PoliciesTable. Anyone with member.read on the account can view a token's
  // policies; only policy admins can mutate them.
  const canManage = usePermission(accountId, 'policy.create').allowed;

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-10">
      <div className="space-y-5">
        <Link
          href={`/accounts/${accountId}`}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors"
        >
          <ChevronLeft className="size-4" />
          Account
        </Link>

        <div className="flex min-w-0 items-center gap-3.5">
          <EntityAvatar icon={KeyRound} size="lg" />
          <div className="min-w-0 space-y-0.5">
            {tokensQuery.isLoading ? (
              <Skeleton className="h-6 w-44" />
            ) : (
              <h2 className="text-foreground truncate text-xl font-medium">
                {token?.name ?? 'Token not found'}
              </h2>
            )}
            {token ? (
              <InlineMeta className="text-sm">
                <span className="capitalize">{token.status}</span>
                <span>Created {formatDate(token.created_at)}</span>
                <span>Last used {formatDate(token.last_used_at)}</span>
              </InlineMeta>
            ) : null}
          </div>
          {token && token.status !== 'active' ? (
            <Badge variant="destructive" size="sm" className="ml-auto shrink-0 capitalize">
              {token.status}
            </Badge>
          ) : null}
        </div>
      </div>

      {!tokensQuery.isLoading && !token && tokenId ? (
        <InfoBanner tone="neutral">
          This token doesn&apos;t exist or has been revoked.
        </InfoBanner>
      ) : null}

      {token && accountId ? (
        <InfoBanner
          tone="info"
          title={tI18nHardcoded.raw('autoAppAppAccountsIdTokensTokenIdPageJsxAttrTitle403e73a7')}
        >
          {tI18nHardcoded.raw('autoAppAppAccountsIdTokensTokenIdPageJsxTextTokensf8e918bc')}
        </InfoBanner>
      ) : null}
    </div>
  );
}
