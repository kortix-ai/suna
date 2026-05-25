'use client';

import { useTranslations } from 'next-intl';

import { useCallback, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, Shield, Trash2, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import {
  accountTokensApi,
  type AccountToken,
  type CreatedAccountToken,
} from '@/lib/api/account-tokens';

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handle = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.warning('Failed to copy to clipboard');
    }
  }, [value]);
  return (
    <Button size="sm" variant="outline" onClick={handle} className="shrink-0">
      {copied ? (
        <>
          <Check className="size-4" /> Copied
        </>
      ) : (
        <>
          <Copy className="size-4" /> Copy
        </>
      )}
    </Button>
  );
}

function TokenRow({ token, onChange }: { token: AccountToken; onChange: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [confirming, setConfirming] = useState(false);
  const revoked = token.status !== 'active';
  const router = useRouter();
  const { selectedAccountId } = useCurrentAccountStore();

  const mutation = useMutation({
    mutationFn: () => accountTokensApi.revoke(token.token_id),
    onSuccess: () => {
      toast.success(`Revoked "${token.name}"`);
      onChange();
    },
    onError: (err) => toast.error((err as Error).message || 'Failed to revoke'),
  });

  return (
    <div className="rounded-2xl border bg-card transition-colors">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate font-medium ${revoked ? 'text-muted-foreground' : ''}`}>
              {token.name}
            </span>
            {revoked && (
              <Badge variant="outline" className="text-muted-foreground">
                {token.status}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span>Created {formatRelative(token.created_at)}</span>
            <span>·</span>
            <span>{tHardcodedUi.raw('componentsSettingsCliTokensTab.line94JsxTextLastUsed')}{formatRelative(token.last_used_at)}</span>
          </div>
        </div>

        {!revoked && !confirming && (
          <div className="flex items-center gap-1">
            {selectedAccountId && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Manage policies for ${token.name}`}
                title={tHardcodedUi.raw('componentsSettingsCliTokensTab.line105JsxAttrTitleManagePermissionPolicies')}
                onClick={() =>
                  router.push(`/accounts/${selectedAccountId}/tokens/${token.token_id}`)
                }
              >
                <Shield className="size-4 text-muted-foreground hover:text-foreground" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Revoke ${token.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-4 text-muted-foreground hover:text-foreground" />
            </Button>
          </div>
        )}
      </div>

      {confirming && !revoked && (
        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            Revoke <strong className="text-foreground">{token.name}</strong>{tHardcodedUi.raw('componentsSettingsCliTokensTab.line128JsxTextAnyCliUsingItWillBeSignedOut')}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Revoke'
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CliTokensTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const tokensQuery = useQuery({
    queryKey: ['account-tokens'],
    queryFn: () => accountTokensApi.list(),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['account-tokens'] });
  }

  const tokens = tokensQuery.data ?? [];
  const active = tokens.filter((t) => t.status === 'active');
  const revoked = tokens.filter((t) => t.status !== 'active');

  return (
    <div className="px-6 py-6 sm:px-8 sm:py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound className="size-5" />{tHardcodedUi.raw('componentsSettingsCliTokensTab.line181JsxTextCliTokens')}</div>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line184JsxTextPersonalAccessTokensForThe')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kortix</code>{' '}{tHardcodedUi.raw('componentsSettingsCliTokensTab.line186JsxTextCliEachTokenAuthenticatesAsYouTreatThem')}</p>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />{tHardcodedUi.raw('componentsSettingsCliTokensTab.line191JsxTextNewToken')}</Button>
        )}
      </div>

      {creating && (
        <div className="mb-4">
          <InlineCreate
            onClose={() => setCreating(false)}
            onCreated={invalidate}
          />
        </div>
      )}

      {tokensQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      ) : tokensQuery.error ? (
        <div className="rounded-2xl border border-destructive bg-destructive/5 p-4 text-sm text-destructive">
          {(tokensQuery.error as Error).message}
        </div>
      ) : tokens.length === 0 && !creating ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="space-y-2">
          {active.map((t) => (
            <TokenRow key={t.token_id} token={t} onChange={invalidate} />
          ))}
          {revoked.length > 0 && (
            <>
              <div className="mt-6 mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Revoked
              </div>
              {revoked.map((t) => (
                <TokenRow key={t.token_id} token={t} onChange={invalidate} />
              ))}
            </>
          )}
        </div>
      )}

      <div className="mt-8 rounded-2xl border bg-muted/30 p-4 text-sm">
        <div className="font-medium">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line235JsxTextUsingTheCli')}</div>
        <pre className="mt-2 overflow-x-auto rounded bg-background px-3 py-2 font-mono text-xs">
{`kortix login --token <paste-from-above>
kortix whoami
kortix projects ls`}
        </pre>
      </div>
    </div>
  );
}

/** A self-contained inline create flow: form → reveal → dismiss. Lives
 *  inside the tab; no nested dialogs. The parent controls visibility via
 *  the `creating` boolean. */
function InlineCreate({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedAccountToken | null>(null);

  const mutation = useMutation({
    mutationFn: () => accountTokensApi.create({ name: name.trim() }),
    onSuccess: (token) => {
      setCreated(token);
      onCreated();
    },
    onError: (err) => toast.error((err as Error).message || 'Failed to create token'),
  });

  if (created) {
    return (
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line274JsxTextTokenCreated')}{created.name}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line277JsxTextCopyItNowItWonAposTBe')}{' '}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line279JsxTextKortixLoginTokenLtPasteGt')}</code>{' '}{tHardcodedUi.raw('componentsSettingsCliTokensTab.line281JsxTextInYourTerminal')}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Dismiss"
            className="-mr-1 -mt-1"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded border bg-background px-3 py-2 font-mono text-xs">
            {created.secret_key}
          </code>
          <CopyButton value={created.secret_key} />
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || mutation.isPending) return;
        mutation.mutate();
      }}
      className="rounded-2xl border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <Label htmlFor="token-name" className="text-sm font-medium">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line317JsxTextTokenName')}</Label>
          <Input
            id="token-name"
            placeholder="my-laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            maxLength={255}
          />
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line329JsxTextUsedOnlyToRecognizeThisTokenLater')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Cancel"
          className="-mr-1 -mt-1"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || mutation.isPending}>
          {mutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            'Create token'
          )}
        </Button>
      </div>
    </form>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="rounded-2xl border border-dashed py-16 text-center">
      <KeyRound className="mx-auto size-8 text-muted-foreground" />
      <div className="mt-3 text-sm font-medium">{tHardcodedUi.raw('componentsSettingsCliTokensTab.line363JsxTextNoTokensYet')}</div>
      <div className="mt-1 text-sm text-muted-foreground">
        Click <strong>{tHardcodedUi.raw('componentsSettingsCliTokensTab.line365JsxTextNewToken')}</strong>{tHardcodedUi.raw('componentsSettingsCliTokensTab.line365JsxTextAboveToMintYourFirstOne')}</div>
      <Button className="mt-4" variant="outline" onClick={onCreate}>
        <Plus className="size-4" />{tHardcodedUi.raw('componentsSettingsCliTokensTab.line368JsxTextNewToken')}</Button>
    </div>
  );
}
