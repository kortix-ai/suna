'use client';

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
import { listAccountMembers } from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

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
import {
  type CreatedScimToken,
  type ScimToken,
  createScimToken,
  getSsoProvider,
  listGroups,
  listScimTokens,
  revokeScimToken,
} from '@/lib/iam-client';

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
function ProvisioningHealthPanel({ accountId }: { accountId: string }) {
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

  return (
    <div className="border-border/60 bg-muted/10 space-y-2 rounded-md border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <ShieldCheck className="size-3.5 shrink-0" />
          Provisioning health
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Refresh provisioning health"
          onClick={() => {
            membersQuery.refetch();
            groupsQuery.refetch();
          }}
        >
          <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-6 w-full rounded" />
      ) : (
        <p className="text-foreground flex items-center gap-1.5 text-xs">
          <Users className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-medium tabular-nums">{scimMemberCount}</span>
          <span className="text-muted-foreground">
            member{scimMemberCount === 1 ? '' : 's'} across {scimGroups.length} SCIM-provisioned
            group{scimGroups.length === 1 ? '' : 's'}
          </span>
        </p>
      )}
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

async function copyToClipboard(value: string, successMsg = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(value);
    successToast(successMsg);
  } catch {
    errorToast('Copy failed — select and copy manually');
  }
}

export function ScimCard({ accountId, canManage }: ScimCardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ScimToken | null>(null);
  const queryClient = useQueryClient();

  const tokensQuery = useQuery({
    queryKey: ['scim-tokens', accountId],
    queryFn: () => listScimTokens(accountId),
    staleTime: 30_000,
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
      successToast('SCIM token revoked');
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to revoke token'),
  });

  const tokens = tokensQuery.data ?? [];
  // The SCIM base URL is what the admin pastes into their IdP (Okta/Azure),
  // which calls it directly — so show the absolute API origin when we know it.
  // Falls back to a relative path (+ the "prepend your origin" hint below) when
  // the backend is configured as a same-origin proxy path.
  const scimBaseUrl = buildScimBaseUrl(accountId, getEnv().BACKEND_URL);
  const scimBaseIsAbsolute = isAbsoluteHttpUrl(scimBaseUrl);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">SCIM provisioning</p>
          <p className="text-muted-foreground text-xs">
            Connect Okta, Azure AD, or any SCIM 2.0 provider to sync users and groups into this
            account.
          </p>
        </div>
        {canManage && (
          // Step-by-step Directory Sync setup per IdP (mirrors the SSO
          // wizard) — mints the token and hands over the Tenant URL inline.
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href={`/accounts/${accountId}/scim-setup`}>Guided setup</Link>
          </Button>
        )}
      </div>

      {!providerQuery.isLoading && !providerQuery.data && (
        <InfoBanner tone="info" title="Connect SAML SSO first">
          Directory Sync provisions accounts, but without SSO those users have no way to sign in.
          Connect the SAML SSO card above before you configure your IdP here.
        </InfoBanner>
      )}

      <div className="bg-popover rounded-md border">
        <div className="space-y-4 px-4 py-5">
          {tokens.length > 0 && <ProvisioningHealthPanel accountId={accountId} />}
          {/* Endpoint URL */}
          <div className="space-y-1.5">
            <Label className="text-xs">SCIM base URL</Label>
            <div className="flex items-center gap-2">
              <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
                {scimBaseUrl}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy SCIM base URL"
                onClick={() => copyToClipboard(scimBaseUrl, 'SCIM URL copied')}
              >
                <Copy className="size-3.5 shrink-0" />
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {scimBaseIsAbsolute ? (
                <>
                  Your IdP appends <code>/Users</code> and <code>/Groups</code>.
                </>
              ) : (
                <>
                  Prepend your API origin (e.g. <code>https://api.kortix.com</code>). The IdP
                  appends <code>/Users</code> and <code>/Groups</code>.
                </>
              )}
            </p>
          </div>

          {/* IdP setup hint — what to fill in on the Okta / Azure side, so admins
              don't have to guess the identifier + auth from docs. */}
          <div className="bg-muted/20 text-muted-foreground space-y-1.5 rounded-md border px-3 py-2.5 text-xs">
            <p className="text-foreground text-xs font-medium">Configure your IdP with</p>
            <div className="flex gap-2">
              <span className="w-24 shrink-0">Identifier</span>
              <span className="text-foreground">
                <code className="bg-muted/60 rounded px-1 py-0.5 font-mono">userName</code> — the
                user's email
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0">Auth</span>
              <span className="text-foreground">Bearer token — Okta HTTP Header mode</span>
            </div>
            <div className="flex gap-2">
              <span className="w-24 shrink-0">Actions</span>
              <span className="text-foreground">
                Push users &amp; groups; deactivation deprovisions
              </span>
            </div>
          </div>
        </div>

        <div className="border-border border-t">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-foreground text-sm font-medium">Bearer tokens</p>
              <p className="text-muted-foreground text-xs">
                Each token authenticates a single IdP integration. Rotate by minting a new one and
                revoking the old.
              </p>
            </div>
            {canManage && (
              <Button
                onClick={() => setCreateOpen(true)}
                size="sm"
                variant="secondary"
                className="shrink-0 gap-1.5"
              >
                <Plus className="size-4 shrink-0" />
                New SCIM token
              </Button>
            )}
          </div>

          <div className="border-border border-t">
            {tokensQuery.isLoading && (
              <div className="space-y-2 px-4 py-4">
                <Skeleton className="h-12 rounded-md" />
                <Skeleton className="h-12 rounded-md" />
              </div>
            )}

            {!tokensQuery.isLoading && tokens.length === 0 && (
              <div className="px-4 py-4">
                <EmptyState
                  icon={KeyRound}
                  size="sm"
                  title="No SCIM tokens yet"
                  description="Create one to connect your IdP."
                />
              </div>
            )}

            {!tokensQuery.isLoading && tokens.length > 0 && (
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
                        <span>Last used {formatRelative(t.last_used_at)}</span>
                        <span>·</span>
                        <span>Created {formatRelative(t.created_at)}</span>
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
          </div>
        </div>
      </div>

      <CreateScimTokenDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title="Revoke SCIM token"
        description={
          revokeTarget
            ? `Any IdP using "${revokeTarget.name}" will lose access immediately. This cannot be undone — you'll need to mint a new token to reconnect.`
            : ''
        }
        confirmLabel="Revoke token"
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
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedScimToken | null>(null);
  // Same absolute-when-known base URL the card shows, so the post-mint view
  // matches (the API returns a relative path in created.scim_base_url).
  const scimBaseUrl = buildScimBaseUrl(accountId, getEnv().BACKEND_URL);

  const mutation = useMutation({
    mutationFn: () => createScimToken(accountId, { name: name.trim() }),
    onSuccess: (token) => {
      setCreated(token);
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to create token'),
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
          <ModalTitle>{created ? 'SCIM token created' : 'Create SCIM token'}</ModalTitle>
          <ModalDescription>
            {created
              ? 'Copy the token now — it will not be shown again. Then configure it in your IdP.'
              : 'Mint a bearer token for an IdP integration. Each integration should get its own token so revocation is targeted.'}
          </ModalDescription>
        </ModalHeader>

        {created ? (
          <>
            <ModalBody className="min-w-0 space-y-4">
              <div>
                <Label className="text-xs">Token</Label>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
                    {created.secret}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy token"
                    onClick={() => copyToClipboard(created.secret, 'Token copied')}
                  >
                    <Copy className="size-3.5 shrink-0" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs">SCIM base URL</Label>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
                    {scimBaseUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy URL"
                    onClick={() => copyToClipboard(scimBaseUrl, 'URL copied')}
                  >
                    <Copy className="size-3.5 shrink-0" />
                  </Button>
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" onClick={() => handleClose(false)} className="gap-1.5">
                <Check className="size-3.5 shrink-0" />
                Done
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <ModalBody className="min-w-0 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="scim-token-name">Name</Label>
                <Input
                  id="scim-token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Okta production"
                  maxLength={128}
                  autoFocus
                  required
                  disabled={mutation.isPending}
                  variant="popover"
                />
                <p className="text-muted-foreground text-xs">
                  Used only to recognise this token later.
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
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || mutation.isPending}
                className="gap-1.5"
              >
                {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
                Mint token
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
