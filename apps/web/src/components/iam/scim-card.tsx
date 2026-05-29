'use client';

import { useTranslations } from 'next-intl';
// SCIM provisioning card on the Settings tab. Two things:
//   1. Surface the per-account SCIM base URL the IdP needs to configure.
//   2. Manage long-lived SCIM bearer tokens (create / list / revoke).
//
// The secret is shown EXACTLY ONCE at creation. After that admins only see
// the public prefix. There is no "regenerate" — you revoke and mint a new
// one, which matches how Okta/Azure AD admins expect to operate.

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
  type CreatedScimToken,
  type ScimToken,
} from '@/lib/iam-client';

interface ScimCardProps {
  accountId: string;
  canManage: boolean;
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
    toast.success(successMsg);
  } catch {
    toast.warning('Copy failed — select and copy manually');
  }
}

export function ScimCard({ accountId, canManage }: ScimCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ScimToken | null>(null);
  const queryClient = useQueryClient();

  const tokensQuery = useQuery({
    queryKey: ['scim-tokens', accountId],
    queryFn: () => listScimTokens(accountId),
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => revokeScimToken(accountId, tokenId),
    onSuccess: () => {
      toast.success('SCIM token revoked');
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to revoke token'),
  });

  const tokens = tokensQuery.data ?? [];
  // SCIM base URL is documented per-account. We can't know the full host
  // from this component (the API may sit on a different domain) so we show
  // a relative path and let the admin prepend their API origin.
  const scimBaseUrl = `/scim/v2/accounts/${accountId}`;

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">{tHardcodedUi.raw('componentsIamScimCard.line97JsxTextSCIMProvisioning')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {tHardcodedUi.raw('componentsIamScimCard.line99JsxTextConnectOktaAzureADOrAnySCIM2')}</p>
      </header>

      <div className="space-y-4 px-6 py-5">
        {/* Endpoint URL */}
        <div className="space-y-1.5">
          <Label className="text-xs">{tHardcodedUi.raw('componentsIamScimCard.line107JsxTextSCIMBaseURL')}</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
              {scimBaseUrl}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label={tHardcodedUi.raw('componentsIamScimCard.line115JsxAttrAriaLabelCopySCIMBaseURL')}
              onClick={() => copyToClipboard(scimBaseUrl, 'SCIM URL copied')}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tHardcodedUi.raw('componentsIamScimCard.line122JsxTextPrependYourAPIOriginEG')}<code>https://api.kortix.com</code>{tHardcodedUi.raw('componentsIamScimCard.line122JsxTextTheIdPAppends')}<code>/Users</code> and <code>/Groups</code>.
          </p>
        </div>

        {/* Tokens header */}
        <div className="flex items-center justify-between border-t border-border/60 pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsIamScimCard.line130JsxTextBearerTokens')}</h3>
            <p className="text-[11px] text-muted-foreground">
              {tHardcodedUi.raw('componentsIamScimCard.line132JsxTextEachTokenAuthenticatesASingleIdPIntegrationRotate')}</p>
          </div>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              {tHardcodedUi.raw('componentsIamScimCard.line139JsxTextNewSCIMToken')}</Button>
          )}
        </div>

        {tokensQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        )}

        {!tokensQuery.isLoading && tokens.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamScimCard.line153JsxTextNoSCIMTokensYetCreateOneToConnect')}</p>
        )}

        {!tokensQuery.isLoading && tokens.length > 0 && (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.token_id}
                className="flex items-center gap-3 rounded-2xl border border-border/60 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {t.name}
                    </span>
                    <Badge
                      variant={t.status === 'active' ? 'outline' : 'destructive'}
                      className="h-4 rounded-md px-1 text-[9px] font-normal capitalize"
                    >
                      {t.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <code className="font-mono">{t.public_prefix}</code>
                    <span>·</span>
                    <span>{tHardcodedUi.raw('componentsIamScimCard.line179JsxTextLastUsed')}{' '}{formatRelative(t.last_used_at)}</span>
                    <span>·</span>
                    <span>Created {formatRelative(t.created_at)}</span>
                  </div>
                </div>
                {canManage && t.status === 'active' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${t.name}`}
                    title={tHardcodedUi.raw('componentsIamScimCard.line189JsxAttrTitleRevokeThisToken')}
                    onClick={() => setRevokeTarget(t)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateScimTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamScimCard.line213JsxAttrTitleRevokeSCIMToken')}
        description={
          revokeTarget
            ? `Any IdP using "${revokeTarget.name}" will lose access immediately. This cannot be undone — you'll need to mint a new token to reconnect.`
            : ''
        }
        confirmLabel={tHardcodedUi.raw('componentsIamScimCard.line219JsxAttrConfirmLabelRevokeToken')}
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.token_id);
        }}
      />
    </section>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedScimToken | null>(null);

  const mutation = useMutation({
    mutationFn: () => createScimToken(accountId, { name: name.trim() }),
    onSuccess: (token) => {
      setCreated(token);
      queryClient.invalidateQueries({ queryKey: ['scim-tokens', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create token'),
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
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? 'SCIM token created' : 'Create SCIM token'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Copy the token now — it will not be shown again. Then configure it in your IdP.'
              : 'Mint a bearer token for an IdP integration. Each integration should get its own token so revocation is targeted.'}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Token</Label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
                  {created.secret}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={tHardcodedUi.raw('componentsIamScimCard.line293JsxAttrAriaLabelCopyToken')}
                  onClick={() => copyToClipboard(created.secret, 'Token copied')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">{tHardcodedUi.raw('componentsIamScimCard.line301JsxTextSCIMBaseURL')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
                  {created.scim_base_url}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={tHardcodedUi.raw('componentsIamScimCard.line309JsxAttrAriaLabelCopyURL')}
                  onClick={() => copyToClipboard(created.scim_base_url, 'URL copied')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)} className="gap-1.5">
                <Check className="h-4 w-4" />
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="scim-token-name">Name</Label>
              <Input
                id="scim-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tHardcodedUi.raw('componentsIamScimCard.line331JsxAttrPlaceholderOktaProduction')}
                maxLength={128}
                autoFocus
                required
                disabled={mutation.isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                {tHardcodedUi.raw('componentsIamScimCard.line338JsxTextUsedOnlyToRecogniseThisTokenLater')}</p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={mutation.isPending}
              >
                <X className="h-4 w-4" />
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || mutation.isPending}>
                {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {tHardcodedUi.raw('componentsIamScimCard.line353JsxTextMintToken')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
