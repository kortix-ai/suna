'use client';

import { useTranslations } from '@/i18n/use-translations';
// SCIM provisioning card on the Settings tab. Two things:
//   1. Surface the per-account SCIM base URL the IdP needs to configure.
//   2. Manage long-lived SCIM bearer tokens (create / list / revoke).
//
// The secret is shown EXACTLY ONCE at creation. After that admins only see
// the public prefix. There is no "regenerate" — you revoke and mint a new
// one, which matches how Okta/Azure AD admins expect to operate.

import { errorToast, successToast } from '@/components/ui/toast';
import { getEnv } from '@/lib/env-config';
import { buildScimBaseUrl, isAbsoluteHttpUrl } from '@/lib/scim-url';
import { cn } from '@/lib/utils';
import { listAccountMembers } from '@kortix/sdk';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  ShieldCheckIcon as ShieldCheck,
  TrashIcon as Trash2,
  UsersIcon as Users,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { SCIM_PROVIDER_GUIDES } from '@/features/sso-setup/guides';
import { CopyRow, formatRelative } from '@/features/workspace/shared/access';
import {
  type CreatedScimToken,
  type ScimToken,
  createScimToken,
  getSsoProvider,
  listGroups,
  listScimTokens,
  revokeScimToken,
} from '@/lib/iam-client';
import { latestScimSyncAt, scimSyncFreshness } from '@/lib/scim-sync';

// Static registry — filter once at module load instead of on every render.
const START_SYNC_GUIDES = SCIM_PROVIDER_GUIDES.filter((g) => g.config.startSyncHint);

interface ScimCardProps {
  accountId: string;
  canManage: boolean;
}

/**
 * Live provisioning health — polls the account's existing member and group
 * lists (no new API surface) so an admin watching an IdP provisioning run
 * doesn't have to tab back and forth to see whether anything landed. Mirrors
 * the wizard's verify-step panel (features/sso-setup/setup-wizard.tsx
 * ProvisionedStatusPanel).
 */
function ProvisioningHealthPanel({
  accountId,
  lastSyncAt,
}: {
  accountId: string;
  /** Newest last_used_at across active SCIM tokens — when the IdP last called us. */
  lastSyncAt: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const membersQuery = useQuery({
    queryKey: ['scim-verify-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['scim-verify-groups', accountId],
    queryFn: () => listGroups(accountId),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });

  const scimGroups = (groupsQuery.data ?? []).filter((g) => g.source === 'scim');
  const scimMemberCount = scimGroups.reduce((sum, g) => sum + (g.member_count ?? 0), 0);
  const isLoading = membersQuery.isLoading || groupsQuery.isLoading;
  const freshness = scimSyncFreshness(lastSyncAt);

  return (
    <div className="border-border/60 bg-muted/10 space-y-2 rounded-md border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <ShieldCheck className="size-3.5 shrink-0" />
          {tI18nComplete.raw('textee676c94b629')}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={tI18nComplete.raw('text01b50fe973da')}
          onClick={() => {
            membersQuery.refetch();
            groupsQuery.refetch();
          }}
        >
          {isLoading ? <Loading className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-6 w-full rounded" />
      ) : (
        <p className="text-foreground flex items-center gap-1.5 text-xs">
          <Users className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-medium tabular-nums">{scimMemberCount}</span>
          <span className="text-muted-foreground">
            {tI18nComplete.raw('texte31ab643c44f')}
            {scimMemberCount === 1 ? '' : 's'} {tI18nComplete.raw('textdeb538b50cb6')}{' '}
            {scimGroups.length} {tI18nComplete.raw('text6ec62587abb7')}
            {scimGroups.length === 1 ? '' : 's'}
          </span>
        </p>
      )}
      {/* Two lines on purpose: label + value stay on one unbreakable line,
          the schedule explainer wraps underneath — the old single-flex row
          wrapped mid-label ("Last sync / activity") on narrow cards. */}
      <div className="space-y-0.5 text-xs">
        <p className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              freshness === 'live' && 'bg-kortix-green',
              freshness === 'recent' && 'bg-kortix-green/60',
              freshness === 'quiet' && 'bg-muted-foreground/40',
              freshness === 'never' && 'bg-kortix-orange',
            )}
          />
          <span className="text-muted-foreground whitespace-nowrap">
            {tI18nComplete.raw('text97df9d6eae8f')}
          </span>
          <span className="text-foreground font-medium whitespace-nowrap">
            {lastSyncAt ? formatRelative(lastSyncAt) : tI18nComplete.raw('text98ca0d518997')}
          </span>
        </p>
        <p className="text-muted-foreground pl-3">
          {freshness === 'never'
            ? tI18nComplete.raw('text60872f0408fe')
            : tI18nComplete.raw('text8f619950b088')}
        </p>
      </div>
    </div>
  );
}

export function ScimCard({ accountId, canManage }: ScimCardProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ScimToken | null>(null);
  const queryClient = useQueryClient();

  const tokensQuery = useQuery({
    queryKey: ['scim-tokens', accountId],
    queryFn: () => listScimTokens(accountId),
    staleTime: 30_000,
    // Poll so "Last sync activity" (last_used_at, stamped by every IdP call)
    // stays current while the card is open — a sync run shows up live.
    refetchInterval: 30_000,
  });
  // Same query key SsoCard uses — React Query dedupes this, so checking
  // whether SAML is connected here costs no extra round-trip. Light-touch
  // ordering nudge only: provisioned accounts still need SSO to sign in, but
  // this card stays fully usable either way (copy, not a hard gate).
  const providerQuery = useQuery({
    queryKey: ['iam-sso-provider', accountId],
    queryFn: () => getSsoProvider(accountId),
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => revokeScimToken(accountId, tokenId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text692fef338a3d'));
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text7f8760fd80df')),
  });

  const tokens = tokensQuery.data ?? [];
  // The SCIM base URL is what the admin pastes into their IdP (Okta/Azure),
  // which calls it directly — so show the absolute API origin when we know it.
  // Falls back to a relative path (+ the "prepend your origin" hint below) when
  // the backend is configured as a same-origin proxy path.
  const scimBaseUrl = buildScimBaseUrl(
    accountId,
    getEnv().BACKEND_URL,
    typeof window === 'undefined' ? null : window.location.origin,
  );
  const scimBaseIsAbsolute = isAbsoluteHttpUrl(scimBaseUrl);

  // Header status chip — the card leads with STATE, not reference data. Same
  // freshness semantics as the health panel: amber only for the one genuinely
  // wrong state (token minted but the IdP has never called).
  const lastSyncAt = latestScimSyncAt(tokens);
  const freshness = scimSyncFreshness(lastSyncAt);
  const activeTokenCount = tokens.filter((t) => t.status === 'active').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            {tI18nComplete.raw('textea18bba8cbdb')}
            {tokens.length > 0 &&
              (freshness === 'never' ? (
                <Badge variant="warning" size="sm">
                  {tI18nComplete.raw('text6b40213b7726')}
                </Badge>
              ) : freshness === 'quiet' ? (
                <Badge variant="outline" size="sm">
                  {tI18nComplete.raw('text12a7bd86e0a4')}
                </Badge>
              ) : (
                <Badge variant="success" size="sm">
                  {tI18nComplete.raw('text96879611650f')}
                </Badge>
              ))}
          </p>
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text1e54b8e6af96')}</p>
        </div>
        {canManage && (
          // Step-by-step Directory Sync setup per IdP (mirrors the SSO
          // wizard) — mints the token and hands over the Tenant URL inline.
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href={`/accounts/${accountId}/scim-setup`}>
              {tI18nComplete.raw('text8ef7823ca89b')}
            </Link>
          </Button>
        )}
      </div>

      {!providerQuery.isLoading && !providerQuery.data && (
        <InfoBanner tone="info" title={tI18nComplete.raw('text74be9df9fd88')}>
          {tI18nComplete.raw('text711cf5ef692d')}
        </InfoBanner>
      )}

      <div className="bg-popover rounded-md border">
        {/* State first: the live health line is the card's headline content —
            reference values live in the collapsed sections below. */}
        <div className="px-4 py-4">
          {tokensQuery.isLoading ? (
            <Skeleton className="h-12 w-full rounded-md" />
          ) : tokensQuery.isError ? (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('text580e68173156')}
              description={
                tokensQuery.error instanceof Error ? tokensQuery.error.message : undefined
              }
              action={
                <Button variant="outline" size="sm" onClick={() => tokensQuery.refetch()}>
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          ) : tokens.length > 0 ? (
            <ProvisioningHealthPanel accountId={accountId} lastSyncAt={lastSyncAt} />
          ) : (
            <EmptyState
              icon={KeyRound}
              size="sm"
              title={tI18nComplete.raw('text898569356612')}
              description={tI18nComplete.raw('text6fc62e5b11d6')}
            />
          )}
        </div>

        {/* Setup-time reference: collapsed once things work — but OPEN while a
            minted token is still waiting for its first IdP call, because that
            is exactly when the admin is pasting these values into the IdP. It
            tucks itself away automatically on the first successful sync. */}
        <div className="border-border border-t">
          {/* `defaultOpen` + `key`, not `open`: this wants a derived STARTING
              value the admin can then override, which a controlled `open` with
              no `onOpenChange` cannot express — it would now freeze the trigger.
              The key re-seeds it when the prompt condition actually flips, so it
              still opens on a fresh token and tucks away after the first sync,
              while a manual collapse in between sticks. */}
          <Disclosure
            key={tokens.length > 0 && freshness === 'never' ? 'awaiting-first-sync' : 'synced'}
            className="group"
            defaultOpen={tokens.length > 0 && freshness === 'never'}
          >
            <DisclosureTrigger>
              <div className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-sm font-medium">
                    {tI18nComplete.raw('text59a5ff1b6b64')}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {tI18nComplete.raw('text1ee88a995467')}
                  </p>
                </div>
                <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </DisclosureTrigger>
            <DisclosureContent contentClassName="border-border border-t">
              <div className="space-y-4 px-4 py-4">
                {/* Endpoint URL */}
                <div className="space-y-1.5">
                  <CopyRow
                    label={tI18nComplete.raw('textbe8fb61fbc84')}
                    value={scimBaseUrl}
                    successMessage={tI18nComplete.raw('text871ec26813da')}
                  />
                  <p className="text-muted-foreground text-xs">
                    {scimBaseIsAbsolute ? (
                      <>
                        {tI18nComplete.raw('text250ab151e9cc')} <code>/Users</code>{' '}
                        {tI18nComplete.raw('text6201111b83a0')} <code>/Groups</code>.
                      </>
                    ) : (
                      <>
                        {tI18nComplete.raw('text7f63d46d6462')} <code>https://api.kortix.com</code>
                        {tI18nComplete.raw('textab5f961f00e8')}
                        <code>/Users</code> {tI18nComplete.raw('text6201111b83a0')}{' '}
                        <code>/Groups</code>.
                      </>
                    )}
                  </p>
                </div>

                {/* IdP setup hint — what to fill in on the Okta / Azure side, so admins
                    don't have to guess the identifier + auth from docs. */}
                <div className="bg-muted/20 text-muted-foreground space-y-1.5 rounded-md border px-3 py-2.5 text-xs">
                  <p className="text-foreground text-xs font-medium">
                    {tI18nComplete.raw('text7a7a526cc8d6')}
                  </p>
                  <div className="flex gap-2">
                    <span className="w-24 shrink-0">{tI18nComplete.raw('text9b10587f84a2')}</span>
                    <span className="text-foreground">
                      <code className="bg-muted/60 rounded px-1 py-0.5 font-mono">userName</code>{' '}
                      {tI18nComplete.raw('text3ba60eb0a910')}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-24 shrink-0">{tI18nComplete.raw('text8eb3ea9bbde6')}</span>
                    <span className="text-foreground">{tI18nComplete.raw('text945491ab1fc3')}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-24 shrink-0">{tI18nComplete.raw('textff8059dc6752')}</span>
                    <span className="text-foreground">{tI18nComplete.raw('textc60816cbaae1')}</span>
                  </div>
                </div>

                {/* Per-provider "flip this switch" cheat sheet — the guides
                    registry is the single source of truth (startSyncHint),
                    each row deep-links into that provider's guided setup. An
                    admin stuck at "waiting for IdP" sees exactly what to turn
                    on without re-entering the wizard. */}
                <div className="bg-muted/20 text-muted-foreground space-y-2 rounded-md border px-3 py-2.5 text-xs">
                  <p className="text-foreground text-xs font-medium">
                    {tI18nComplete.raw('textc8f3dd364de4')}
                  </p>
                  {START_SYNC_GUIDES.map((g) => (
                    <div key={g.id} className="flex gap-2">
                      <span className="w-24 shrink-0">{g.name.split(' (')[0]}</span>
                      <span className="text-foreground min-w-0 flex-1">
                        {g.config.startSyncHint}{' '}
                        <Link
                          href={`/accounts/${accountId}/scim-setup?provider=${g.id}`}
                          className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                        >
                          {tI18nComplete.raw('text8dd65d0952ed')}
                        </Link>
                      </span>
                    </div>
                  ))}
                  <p>{tI18nComplete.raw('text4e57226ad8a2')}</p>
                </div>
              </div>
            </DisclosureContent>
          </Disclosure>
        </div>

        <div className="border-border border-t">
          <Disclosure className="group">
            <DisclosureTrigger>
              <div className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-foreground flex items-center gap-2 text-sm font-medium">
                    {tI18nComplete.raw('text3759abe4b19b')}
                    {activeTokenCount > 0 && (
                      <Badge variant="muted" size="sm">
                        {activeTokenCount} {tI18nComplete.raw('text96879611650f')}
                      </Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {tI18nComplete.raw('text86a9a827d7f4')}
                  </p>
                </div>
                <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </DisclosureTrigger>
            <DisclosureContent contentClassName="border-border border-t">
              {canManage && (
                <div className="flex justify-end px-4 pt-3">
                  <Button
                    onClick={() => setCreateOpen(true)}
                    size="sm"
                    variant="secondary"
                    className="shrink-0 gap-1.5"
                  >
                    <Plus className="size-4 shrink-0" />
                    {tI18nComplete.raw('text6e0317352d63')}
                  </Button>
                </div>
              )}

              {tokensQuery.isLoading && (
                <div className="space-y-2 px-4 py-4">
                  <Skeleton className="h-12 rounded-md" />
                  <Skeleton className="h-12 rounded-md" />
                </div>
              )}

              {!tokensQuery.isLoading && tokensQuery.isError && (
                <div className="px-4 py-4">
                  <ErrorState
                    size="sm"
                    title={tI18nComplete.raw('text964a40d78cbf')}
                    description={
                      tokensQuery.error instanceof Error ? tokensQuery.error.message : undefined
                    }
                    action={
                      <Button variant="outline" size="sm" onClick={() => tokensQuery.refetch()}>
                        {tI18nComplete.raw('text942087cc2d41')}
                      </Button>
                    }
                  />
                </div>
              )}

              {!tokensQuery.isLoading && !tokensQuery.isError && tokens.length === 0 && (
                <div className="px-4 py-4">
                  <EmptyState
                    icon={KeyRound}
                    size="sm"
                    title={tI18nComplete.raw('textb13bbdebd165')}
                    description={tI18nComplete.raw('textf1750835530d')}
                  />
                </div>
              )}

              {!tokensQuery.isLoading && !tokensQuery.isError && tokens.length > 0 && (
                <div className="divide-border divide-y">
                  {tokens.map((t) => (
                    <div key={t.token_id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{t.name}</span>
                          <Badge variant={t.status === 'active' ? 'success' : 'muted'} size="sm">
                            {t.status}
                          </Badge>
                        </div>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-3 text-xs">
                          <code className="font-mono">{t.public_prefix}</code>
                          <span>·</span>
                          <span>
                            {tI18nComplete.raw('text830ec7f812f9')} {formatRelative(t.last_used_at)}
                          </span>
                          <span>·</span>
                          <span>
                            {tI18nComplete.raw('textd70b9e24bca2')} {formatRelative(t.created_at)}
                          </span>
                        </div>
                      </div>
                      {canManage && t.status === 'active' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Revoke ${t.name}`}
                          onClick={() => setRevokeTarget(t)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5 shrink-0" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </DisclosureContent>
          </Disclosure>
        </div>
      </div>

      <CreateScimTokenDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title={tI18nComplete.raw('texte57912d50189')}
        description={
          revokeTarget ? tI18nComplete('texte47b85588c7c', { value0: revokeTarget.name }) : ''
        }
        confirmLabel={tI18nComplete.raw('text14683b379324')}
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.token_id);
        }}
      />
    </div>
  );
}

// ─── Create-token dialog with one-shot secret reveal ──────────────────────

function CreateScimTokenDialog({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedScimToken | null>(null);
  // Same absolute-when-known base URL the card shows, so the post-mint view
  // matches (the API returns a relative path in created.scim_base_url).
  const scimBaseUrl = buildScimBaseUrl(
    accountId,
    getEnv().BACKEND_URL,
    typeof window === 'undefined' ? null : window.location.origin,
  );

  const mutation = useMutation({
    mutationFn: () => createScimToken(accountId, { name: name.trim() }),
    onSuccess: (token) => {
      setCreated(token);
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textf8a44ba9cc41')),
  });

  function handleClose(next: boolean) {
    if (mutation.isPending) return;
    if (!next) {
      // Wipe state so the next open doesn't show stale data — especially
      // important for the secret which we never want to show twice.
      setName('');
      setCreated(null);
    }
    onOpenChange(next);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || mutation.isPending || created) return;
    mutation.mutate();
  }

  return (
    <Modal open={open} onOpenChange={handleClose}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>
            {created
              ? tI18nComplete.raw('text6759c496ac63')
              : tI18nComplete.raw('texte550c4aaeecf')}
          </ModalTitle>
          <ModalDescription>
            {created
              ? tI18nComplete.raw('textc187d313e143')
              : tI18nComplete.raw('text9574f64a20a6')}
          </ModalDescription>
        </ModalHeader>

        {created ? (
          <>
            <ModalBody className="min-w-0 space-y-4">
              <CopyRow
                label={tI18nComplete.raw('textd2089be67295')}
                value={created.secret}
                successMessage={tI18nComplete.raw('textc9feac7acc32')}
              />
              <CopyRow
                label={tI18nComplete.raw('textbe8fb61fbc84')}
                value={scimBaseUrl}
                successMessage={tI18nComplete.raw('text0017bda47853')}
              />
            </ModalBody>
            <ModalFooter>
              <Button size="sm" onClick={() => handleClose(false)} className="gap-1.5">
                <Check className="size-3.5 shrink-0" />
                {tI18nComplete.raw('text11a6767d5674')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <ModalBody className="min-w-0 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="scim-token-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
                <Input
                  id="scim-token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tI18nComplete.raw('text33d39c4cbb53')}
                  maxLength={128}
                  autoFocus
                  required
                  disabled={mutation.isPending}
                  variant="popover"
                />
                <p className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('textece695b31ede')}
                </p>
              </div>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                onClick={() => handleClose(false)}
                disabled={mutation.isPending}
              >
                {tI18nComplete.raw('text19766ed6ccb2')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || mutation.isPending}
                className="gap-1.5"
              >
                {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
                {tI18nComplete.raw('text4f4003ab9539')}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
