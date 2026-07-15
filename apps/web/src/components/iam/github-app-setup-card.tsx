'use client';

// Self-host: one coherent "managed-git" setup card covering all three ways
// to configure it — create a GitHub App in-app (manifest flow, recommended),
// paste in credentials for an App that already exists, or a personal/
// fine-grained access token for the quickest path. No CLI, no SSH.
//
// On the hosted Kortix deployment (source 'env') the App is configured by
// the operator via env vars — this card still renders there, but as a
// read-only "Connected via environment" summary; the separate cloud
// `GitHubConnectionCard` (per-account App installs) is what a hosted
// customer actually uses, gated on `source === 'env'` at the call site in
// accounts/[id]/page.tsx.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileCode2, Github, KeyRound } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type GitHubAppStatus,
  disconnectGitHubApp,
  getGitHubAppStatus,
  setGitHubAppFromExisting,
  setGitHubAppPat,
  startGitHubAppManifest,
} from '@kortix/sdk/platform-client';

export const GITHUB_APP_STATUS_KEY = ['github-app-status'];

/** Shared so the accounts page can gate the cloud `GitHubConnectionCard` on
 *  the same status this card renders from — one query, one source of truth. */
export function useGitHubAppStatus(enabled = true) {
  return useQuery({
    queryKey: GITHUB_APP_STATUS_KEY,
    queryFn: () => getGitHubAppStatus(),
    staleTime: 10_000,
    enabled,
  });
}

/**
 * Build + submit a same-window POST form to GitHub's "create app from
 * manifest" endpoint. GitHub only accepts the manifest via a POST body field
 * (`manifest`, JSON-stringified) with `state` as a query param on the
 * action URL — a GET or a client-side redirect won't do, so this constructs
 * a real <form> in the DOM and submits it, which navigates the browser away
 * from the SPA to GitHub.
 */
function submitManifestForm(
  githubCreateUrl: string,
  state: string,
  manifest: Record<string, unknown>,
) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${githubCreateUrl}${githubCreateUrl.includes('?') ? '&' : '?'}state=${encodeURIComponent(state)}`;
  form.style.display = 'none';
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

type SetupMethod = 'manifest' | 'existing-app' | 'pat';

function methodLabel(source: GitHubAppStatus['source']): string {
  switch (source) {
    case 'db':
      return 'GitHub App';
    case 'env':
      return 'GitHub App (environment)';
    case 'pat':
      return 'Personal access token';
    default:
      return '';
  }
}

interface GitHubAppSetupCardProps {
  canManage: boolean;
}

export function GitHubAppSetupCard({ canManage }: GitHubAppSetupCardProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [org, setOrg] = useState('');
  const [method, setMethod] = useState<SetupMethod>('manifest');
  const [reconfiguring, setReconfiguring] = useState(false);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);

  const [appId, setAppId] = useState('');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [appInstallationId, setAppInstallationId] = useState('');

  const [patToken, setPatToken] = useState('');
  const [patOwner, setPatOwner] = useState('');

  const statusQuery = useGitHubAppStatus(canManage);

  // GitHub's install flow ends with the backend 302-ing back here with
  // `?github=connected` once the app is created + installed. Surface it once,
  // strip the param so a refresh doesn't re-toast, and refetch status so the
  // connected view appears without a manual reload.
  const githubReturnFlag = searchParams.get('github');
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only reacts to the `github` flag — re-running on every searchParams/queryClient identity change (incl. our own replace() below) would loop.
  useEffect(() => {
    if (githubReturnFlag !== 'connected') return;
    successToast('GitHub connected');
    const next = new URLSearchParams(searchParams.toString());
    next.delete('github');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY });
  }, [githubReturnFlag]);

  const startMutation = useMutation({
    mutationFn: () => startGitHubAppManifest({ org: org.trim() || undefined }),
    onSuccess: ({ github_create_url, manifest, state }) => {
      // Guard: never POST a malformed manifest to GitHub — that's what produces
      // the opaque "'url' wasn't supplied" error page. If the homepage url is
      // missing, surface a clear message instead of bouncing to GitHub.
      if (!manifest || typeof manifest.url !== 'string' || !manifest.url.startsWith('http')) {
        // eslint-disable-next-line no-console
        console.error('[github-app] manifest is malformed, not submitting:', manifest);
        errorToast('GitHub setup failed', {
          description:
            'The app manifest came back without a valid homepage URL. Retry, or use the token option below.',
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.debug('[github-app] submitting manifest to GitHub:', manifest);
      submitManifestForm(github_create_url, state, manifest);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start GitHub App setup'),
  });

  function onSetupSuccess(message: string) {
    successToast(message);
    setReconfiguring(false);
    queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY });
  }

  const appMutation = useMutation({
    mutationFn: () =>
      setGitHubAppFromExisting({
        appId: appId.trim(),
        privateKey: appPrivateKey.trim(),
        installationId: appInstallationId.trim(),
      }),
    onSuccess: () => {
      setAppId('');
      setAppPrivateKey('');
      setAppInstallationId('');
      onSetupSuccess('GitHub App connected');
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to connect the GitHub App'),
  });

  const patMutation = useMutation({
    mutationFn: () => setGitHubAppPat({ token: patToken.trim(), owner: patOwner.trim() }),
    onSuccess: () => {
      setPatToken('');
      setPatOwner('');
      onSetupSuccess('GitHub token connected');
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to connect the token'),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectGitHubApp(),
    onSuccess: () => {
      successToast('GitHub disconnected');
      setConfirmDisconnectOpen(false);
      setReconfiguring(false);
      queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to disconnect GitHub'),
  });

  if (!canManage) return null;

  if (statusQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    );
  }

  // NEVER render a blank Git tab. A 403 means the signed-in user isn't a
  // platform admin (KORTIX_PLATFORM_ADMIN_EMAILS on self-host) — say so
  // instead of silently hiding the only content in the pane. Any other error
  // gets a visible, retryable state.
  if (statusQuery.isError || !statusQuery.data) {
    const status = (statusQuery.error as { status?: number } | null)?.status;
    const forbidden = status === 403;
    return (
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">Managed GitHub</p>
        <p className="text-muted-foreground text-sm">
          {forbidden
            ? 'Only a platform admin can view or configure the GitHub connection for this server. Ask your operator to add your email to KORTIX_PLATFORM_ADMIN_EMAILS.'
            : 'Could not load the GitHub connection status.'}
        </p>
        {!forbidden ? (
          <Button variant="outline" size="sm" onClick={() => statusQuery.refetch()}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  const status: GitHubAppStatus = statusQuery.data;
  const showSetup = !status.configured || reconfiguring;

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">Managed GitHub</p>
        <p className="text-muted-foreground text-xs">
          {status.configured
            ? 'Powers repository creation and pushes for this instance.'
            : 'Every Kortix project is a git repository the server creates and pushes to on your behalf — connect GitHub to enable projects.'}
        </p>
      </div>

      {showSetup ? (
        <div className="space-y-3">
          {reconfiguring ? (
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setReconfiguring(false)}
              >
                Cancel
              </Button>
            </div>
          ) : null}

          <Tabs value={method} onValueChange={(v) => setMethod(v as SetupMethod)}>
            <TabsList type="underline" className="flex w-full items-center justify-start">
              <TabsTrigger value="manifest" className="w-fit flex-none gap-1.5">
                Create GitHub App
                <Badge variant="highlight" size="xs">
                  Recommended
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="existing-app" className="w-fit flex-none">
                Paste an existing App
              </TabsTrigger>
              <TabsTrigger value="pat" className="w-fit flex-none">
                Use a token
              </TabsTrigger>
            </TabsList>

            <TabsContent value="manifest" className="space-y-3 pt-4">
              <p className="text-muted-foreground text-xs">
                Creates a GitHub App owned by your org — scoped permissions, revocable anytime, no
                long-lived token to leak. You&apos;ll pick which repos to grant at install.
              </p>
              <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
                <div className="space-y-1.5">
                  <Label className="text-xs">GitHub organization (optional)</Label>
                  <Input
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    placeholder="e.g. acme-inc"
                    disabled={startMutation.isPending}
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    Leave blank to create the App under your personal GitHub account instead of an
                    organization.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                >
                  {startMutation.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : (
                    <Github className="size-4" />
                  )}
                  {startMutation.isPending ? 'Redirecting to GitHub' : 'Create GitHub App'}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="existing-app" className="space-y-3 pt-4">
              <p className="text-muted-foreground text-xs">
                Already have a GitHub App — created by hand, or shared from another instance? Paste
                its credentials and installation below.
              </p>
              <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
                <div className="space-y-1.5">
                  <Label className="text-xs">App ID</Label>
                  <Input
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="123456"
                    disabled={appMutation.isPending}
                    variant="popover"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Private key (PEM)</Label>
                  <Textarea
                    value={appPrivateKey}
                    onChange={(e) => setAppPrivateKey(e.target.value)}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----"
                    disabled={appMutation.isPending}
                    rows={5}
                    className="resize-y font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Installation ID</Label>
                  <Input
                    value={appInstallationId}
                    onChange={(e) => setAppInstallationId(e.target.value)}
                    placeholder="987654"
                    disabled={appMutation.isPending}
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    From the App&apos;s installation URL:
                    github.com/settings/installations/&lt;id&gt;
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={
                    appMutation.isPending ||
                    !appId.trim() ||
                    !appPrivateKey.trim() ||
                    !appInstallationId.trim()
                  }
                  onClick={() => appMutation.mutate()}
                >
                  {appMutation.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : (
                    <FileCode2 className="size-4" />
                  )}
                  {appMutation.isPending ? 'Connecting' : 'Connect App'}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="pat" className="space-y-3 pt-4">
              <p className="text-muted-foreground text-xs">
                Quickest to set up, but a plain token rather than a scoped, revocable App. Create a
                dedicated fine-grained token scoped to only the repos you want (GitHub → Settings →
                Developer settings → Fine-grained tokens) — don&apos;t paste your everyday personal
                token.
              </p>
              <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
                <div className="space-y-1.5">
                  <Label className="text-xs">Personal / fine-grained access token</Label>
                  <Input
                    type="password"
                    value={patToken}
                    onChange={(e) => setPatToken(e.target.value)}
                    placeholder="github_pat_..."
                    disabled={patMutation.isPending}
                    variant="popover"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">GitHub owner (user or org)</Label>
                  <Input
                    value={patOwner}
                    onChange={(e) => setPatOwner(e.target.value)}
                    placeholder="e.g. acme-inc"
                    disabled={patMutation.isPending}
                    variant="popover"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={patMutation.isPending || !patToken.trim() || !patOwner.trim()}
                  onClick={() => patMutation.mutate()}
                >
                  {patMutation.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                  {patMutation.isPending ? 'Connecting' : 'Connect token'}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <div className="bg-popover flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3.5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-foreground truncate text-sm font-medium">
                {status.owner ?? 'Managed GitHub'}
              </span>
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              <span>{methodLabel(status.source)}</span>
              {status.slug ? (
                <a
                  href={`https://github.com/apps/${status.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1"
                >
                  {status.slug}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
              {status.installation_id ? <span>Installation {status.installation_id}</span> : null}
            </div>
          </div>
          {status.source === 'env' ? (
            <span className="text-muted-foreground text-xs">Configured via environment</span>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setReconfiguring(true)}
              >
                Reconfigure
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDisconnectOpen(true)}
              >
                Disconnect
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnectOpen}
        onOpenChange={setConfirmDisconnectOpen}
        title="Disconnect GitHub?"
        description="Projects that already have a repo keep working, but Kortix won't be able to create new managed repos until you reconnect."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        onConfirm={() => disconnectMutation.mutate()}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}
