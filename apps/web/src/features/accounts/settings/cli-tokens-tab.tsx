'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { useCopy } from '@/hooks/use-copy';
import {
  accountTokensApi,
  type AccountToken,
  type CreatedAccountToken,
} from '@/lib/api/account-tokens';
import { listProjectsForAccount, type KortixProject } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { ShieldSolid, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

/** Sentinel Select value for the account-wide (no project) scope. */
const ACCOUNT_SCOPE = '__account__';

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function ScopeBadge({
  projectId,
  projects,
}: {
  projectId: string | null;
  projects: KortixProject[];
}) {
  if (!projectId) {
    return (
      <Badge variant="muted" size="xs">
        Account-wide
      </Badge>
    );
  }
  const name = projects.find((p) => p.project_id === projectId)?.name;
  return (
    <Badge variant="muted" size="xs">
      {name ?? shortId(projectId)}
    </Badge>
  );
}

function CopyButton({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button size="sm" variant="outline" onClick={() => copy(value)} className="shrink-0">
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

function TokenRow({
  token,
  projects,
  onChange,
}: {
  token: AccountToken;
  projects: KortixProject[];
  onChange: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [confirming, setConfirming] = useState(false);
  const revoked = token.status !== 'active';
  const router = useRouter();
  const { selectedAccountId } = useCurrentAccountStore();

  const mutation = useMutation({
    mutationFn: () => accountTokensApi.revoke(token.token_id),
    onSuccess: () => {
      successToast(`Revoked "${token.name}"`);
      onChange();
    },
    onError: (err) => errorToast((err as Error).message || 'Failed to revoke'),
  });

  return (
    <div className="bg-card rounded-lg border transition-colors">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm font-medium',
                revoked ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {token.name}
            </span>
            <ScopeBadge projectId={token.project_id} projects={projects} />
            {revoked && <Badge variant="destructive">{token.status}</Badge>}
          </div>
          <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
            <span>Created {formatRelative(token.created_at)}</span>
            <span>
              {tI18nHardcoded.raw('autoFeaturesAccountsSettingsCliTokensTabJsxTextBullbb9413cf')}
            </span>
            <span>
              {tHardcodedUi.raw('componentsSettingsCliTokensTab.line94JsxTextLastUsed')}{' '}
              {formatRelative(token.last_used_at)}
            </span>
          </div>
        </div>

        {!revoked && !confirming && (
          <div className="flex items-center gap-1">
            {selectedAccountId && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Manage policies for ${token.name}`}
                title={tHardcodedUi.raw(
                  'componentsSettingsCliTokensTab.line105JsxAttrTitleManagePermissionPolicies',
                )}
                onClick={() =>
                  router.push(`/accounts/${selectedAccountId}/tokens/${token.token_id}`)
                }
              >
                <ShieldSolid className="text-muted-foreground hover:text-foreground size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Revoke ${token.name}`}
              onClick={() => setConfirming(true)}
            >
              <TrashSolid />
            </Button>
          </div>
        )}
      </div>

      {confirming && !revoked && (
        <div className="bg-muted/40 flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            Revoke <span className="text-foreground">{token.name}</span>
            {tHardcodedUi.raw(
              'componentsSettingsCliTokensTab.line128JsxTextAnyCliUsingItWillBeSignedOut',
            )}
          </span>
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
              {mutation.isPending ? <Loading /> : 'Revoke'}
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
  const { selectedAccountId } = useCurrentAccountStore();
  const [creating, setCreating] = useState(false);

  const tokensQuery = useQuery({
    queryKey: ['account-tokens'],
    queryFn: () => accountTokensApi.list(),
  });

  const projectsQuery = useQuery({
    queryKey: ['projects', selectedAccountId],
    queryFn: () => listProjectsForAccount(selectedAccountId ?? undefined),
    staleTime: 30_000,
  });
  const projects = projectsQuery.data ?? [];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['account-tokens'] });
  }

  const tokens = tokensQuery.data ?? [];
  const active = tokens.filter((t) => t.status === 'active');
  const revoked = tokens.filter((t) => t.status !== 'active');

  return (
    <div className="scrollbar-hide w-full max-w-full min-w-0 space-y-6 overflow-x-hidden px-6 py-5">
      {creating && (
        <div className="mb-4">
          <InlineCreate
            projects={projects}
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
        <div className="border-destructive bg-destructive/5 text-destructive rounded-2xl border p-4 text-sm">
          {(tokensQuery.error as Error).message}
        </div>
      ) : tokens.length === 0 && !creating ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description={
            <>
              Click <strong>Create API key</strong> above to mint your first one.
            </>
          }
          action={
            <Button onClick={() => setCreating(true)}>
              <Icon.Plus className="size-4" />
              Create API key
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {active.map((t) => (
            <TokenRow key={t.token_id} token={t} projects={projects} onChange={invalidate} />
          ))}
          {revoked.length > 0 && (
            <div className="space-y-3">
              <label className="text-muted-foreground text-sm font-medium">Revoked</label>
              {revoked.map((t) => (
                <TokenRow key={t.token_id} token={t} projects={projects} onChange={invalidate} />
              ))}
            </div>
          )}
        </div>
      )}

      <Separator />

      <div className="bg-foreground/5 overflow-hidden rounded-lg border text-sm">
        <div className="px-4 py-2">
          <span className="font-medium">
            {tHardcodedUi.raw('componentsSettingsCliTokensTab.line235JsxTextUsingTheCli')}
          </span>
        </div>
        <pre className="bg-foreground text-background overflow-x-auto rounded-t-lg px-4 py-3 font-mono text-xs">
          {`kortix login --token <paste-from-above>
kortix whoami
kortix projects ls`}
        </pre>
      </div>
    </div>
  );
}

function InlineCreate({
  projects,
  onClose,
  onCreated,
}: {
  projects: KortixProject[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(ACCOUNT_SCOPE);
  const [created, setCreated] = useState<CreatedAccountToken | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      accountTokensApi.create({
        name: name.trim(),
        project_id: scope === ACCOUNT_SCOPE ? undefined : scope,
      }),
    onSuccess: (token) => {
      setCreated(token);
      onCreated();
    },
    onError: (err) => errorToast((err as Error).message || 'Failed to create API key'),
  });

  if (created) {
    return (
      <div className="border-primary/30 bg-primary/5 rounded-2xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">
              {tHardcodedUi.raw('componentsSettingsCliTokensTab.line274JsxTextTokenCreated')}
              {created.name}
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {tHardcodedUi.raw(
                'componentsSettingsCliTokensTab.line277JsxTextCopyItNowItWonAposTBe',
              )}{' '}
              <code className="bg-background rounded px-1 py-0.5 font-mono text-xs">
                {tHardcodedUi.raw(
                  'componentsSettingsCliTokensTab.line279JsxTextKortixLoginTokenLtPasteGt',
                )}
              </code>{' '}
              {tHardcodedUi.raw('componentsSettingsCliTokensTab.line281JsxTextInYourTerminal')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Dismiss"
            className="-mt-1 -mr-1"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <code className="bg-background flex-1 truncate rounded border px-3 py-2 font-mono text-xs">
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
      className="bg-card rounded-2xl border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token-name" className="text-sm font-medium">
              API key name
            </Label>
            <Input
              id="token-name"
              placeholder="my-laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              maxLength={255}
            />
            <p className="text-muted-foreground text-xs">
              Used only to recognize this API key later.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="token-scope" className="text-sm font-medium">
              Scope
            </Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id="token-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ACCOUNT_SCOPE}>Account-wide</SelectItem>
                {projects.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Project</SelectLabel>
                    {projects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Account-wide keys reach every project. A project key is limited to that one project.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Cancel"
          className="-mt-1 -mr-1"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Create API key'}
        </Button>
      </div>
    </form>
  );
}
