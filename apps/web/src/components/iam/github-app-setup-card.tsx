'use client';

// Self-host: one coherent "managed-git" setup card covering all three ways
// to configure it — create a GitHub App in-app (manifest flow, recommended),
// paste in credentials for an App that already exists, or a personal/
// fine-grained access token for the quickest path. No CLI, no SSH.
//
// Layout, and why it is this shape:
//
//   header       title + one status badge + what managed-git actually does
//   ├ setup      ONE bordered group. Three method rows, hairline-separated,
//   │            each stating its own tradeoff up front; the selected row
//   │            reveals its form directly beneath it.
//   └ connected  identity row (owner) → labelled facts grid → action footer
//
// The setup step used to be an underline tab strip: three long triggers plus a
// badge, no horizontal scroll, inside a `max-w-2xl` settings panel — it broke
// at mobile width, and each option's tradeoff ("scoped and revocable" versus
// "a plain long-lived token") was only readable after clicking that tab. Rows
// put all three tradeoffs on screen at once and stack instead of overflowing.
//
// The connected step used to be a single row with owner, method, App slug and
// installation id run together in one wrapping line of muted text, so nothing
// but the installation id said what it was. Every fact is now labelled, and
// this file's sibling `sso-card.tsx` uses the same two-column `<dl>` for the
// same job.
//
// On the hosted Kortix deployment (source 'env') the App is configured by the
// operator via env vars — this card still renders there, but its footer says
// so and offers no controls; the separate cloud `GitHubConnectionCard`
// (per-account App installs) is what a hosted customer actually uses, gated on
// `source === 'env'` at the call site in accounts/[id]/page.tsx.

import {
  ArrowSquareOutIcon as ExternalLink,
  FileCodeIcon as FileCode2,
  KeyIcon as KeyRound,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { Github } from '@/features/icon/icons/github';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  type GitHubAppStatus,
  disconnectGitHubApp,
  getGitHubAppStatus,
  setGitHubAppFromExisting,
  setGitHubAppPat,
  startGitHubAppManifest,
} from '@kortix/sdk';

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

/**
 * The three methods, with the tradeoff each one makes stated on the row itself.
 * This is the whole point of the rows-over-tabs change: a reader choosing how
 * to connect can compare all three without clicking any of them.
 */
const SETUP_METHODS: ReadonlyArray<{
  id: SetupMethod;
  title: string;
  tradeoff: string;
  recommended?: boolean;
}> = [
  {
    id: 'manifest',
    title: 'Create a GitHub App',
    tradeoff:
      'Scoped permissions, revocable any time, no long-lived token to leak. You pick which repositories it reaches while installing it.',
    recommended: true,
  },
  {
    id: 'existing-app',
    title: 'Paste an existing App',
    tradeoff:
      'Same security, for an App you already made or share across instances. Needs its App ID, private key and installation ID.',
  },
  {
    id: 'pat',
    title: 'Use an access token',
    tradeoff:
      'Fastest, and the weakest: one long-lived token instead of a scoped per-repository grant.',
  },
];

/** How managed-git authenticates to GitHub — the mechanism only. Where the
 *  configuration came from ('env' versus the UI) is a separate axis, carried by
 *  the header badge and the footer note. */
function methodLabel(source: GitHubAppStatus['source']): string {
  switch (source) {
    case 'db':
    case 'env':
      return 'GitHub App';
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
  const fieldId = useId();

  const [org, setOrg] = useState('');
  const [method, setMethod] = useState<SetupMethod>('manifest');
  const [reconfiguring, setReconfiguring] = useState(false);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);

  const [appId, setAppId] = useState('');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [appInstallationId, setAppInstallationId] = useState('');
  const [appClientId, setAppClientId] = useState('');
  const [appClientSecret, setAppClientSecret] = useState('');

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
        clientId: appClientId.trim() || undefined,
        clientSecret: appClientSecret.trim() || undefined,
      }),
    onSuccess: () => {
      setAppId('');
      setAppPrivateKey('');
      setAppInstallationId('');
      setAppClientId('');
      setAppClientSecret('');
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
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-44 w-full rounded-md" />
      </div>
    );
  }

  // Account GitHub App connections render independently on the Git tab. Hide
  // this server-level operator panel from account admins who are not platform
  // admins. Other errors remain visible and retryable.
  if (statusQuery.isError || !statusQuery.data) {
    // Robust auth-failure detection: the SDK's ApiError carries `.status`, but
    // depending on the failure path the code can sit on `.response.status` or
    // only in the message — a non-admin must NEVER see the scary generic error.
    const err = statusQuery.error as {
      status?: number;
      response?: { status?: number };
      message?: string;
    } | null;
    const status = err?.status ?? err?.response?.status;
    const forbidden =
      status === 403 ||
      status === 401 ||
      /\b(403|401|forbidden|unauthorized|admin access)\b/i.test(err?.message ?? '');
    if (forbidden) return null;
    return (
      <div className="space-y-4">
        <CardHeading />
        <div className="bg-popover rounded-md border px-4 py-5">
          <ErrorState
            size="sm"
            title="Couldn't load GitHub status"
            description={err?.message || undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => statusQuery.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const status: GitHubAppStatus = statusQuery.data;
  const showSetup = !status.configured || reconfiguring;
  const anyPending = startMutation.isPending || appMutation.isPending || patMutation.isPending;

  return (
    <div className="space-y-4">
      <CardHeading
        badges={
          <>
            {status.configured ? (
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            ) : (
              <Badge variant="muted" size="sm">
                Not connected
              </Badge>
            )}
            {status.configured && status.source === 'env' ? (
              <Badge variant="muted" size="sm">
                Environment
              </Badge>
            ) : null}
          </>
        }
        description={
          status.configured
            ? 'Powers repository creation and pushes for every project on this instance.'
            : 'Every Kortix project is a git repository the server creates and pushes to on your behalf. Connect GitHub once here to enable projects.'
        }
        action={
          reconfiguring ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={anyPending}
              onClick={() => setReconfiguring(false)}
            >
              Cancel
            </Button>
          ) : null
        }
      />

      {showSetup ? (
        <div className="space-y-3">
          {reconfiguring ? (
            <InfoBanner tone="warning" icon={WarningIcon} title="Replacing the current connection">
              The connection you have now keeps working until a replacement is saved.
            </InfoBanner>
          ) : null}

          {/* One bordered group; the rows are its hairline-divided children, so
              nothing nests a second radius inside the first. `RadioGroup` owns
              the roving tab index, arrow-key navigation and announcement — the
              rows are `RadioGroupItem`s, not a hand-rolled selection list. */}
          <RadioGroup
            value={method}
            onValueChange={(value) => setMethod(value as SetupMethod)}
            aria-label="How Kortix authenticates to GitHub"
            className="bg-popover divide-border gap-0 divide-y overflow-hidden rounded-md border"
          >
            {SETUP_METHODS.map((entry) => (
              // Controlled with no `onOpenChange` on purpose: the radio owns
              // `method`, and `method` owns every row's open state. A toggle
              // here would be a second source of truth for the same fact.
              // (See disclosure.tsx's own note on the controlled contract.)
              <Disclosure key={entry.id} open={method === entry.id}>
                <RadioGroupItem
                  value={entry.id}
                  // `size="lg"` is what supplies `px-4`, matching the panel
                  // rhythm — the size classes land after `className` in the
                  // item's own `cn`, so padding cannot be overridden here.
                  size="lg"
                  disabled={anyPending}
                  className="rounded-none"
                  label={
                    <span className="flex flex-wrap items-center gap-2">
                      {entry.title}
                      {entry.recommended ? (
                        <Badge variant="highlight" size="xs">
                          Recommended
                        </Badge>
                      ) : null}
                    </span>
                  }
                  description={entry.tradeoff}
                />

                <DisclosureContent contentClassName="border-border border-t">
                  {entry.id === 'manifest' ? (
                    <div className="space-y-4 px-4 py-5">
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        GitHub opens next: you confirm the App, choose which repositories it may
                        access, and land back here connected.
                      </p>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-org`} className="text-xs">
                          GitHub organization (optional)
                        </Label>
                        <Input
                          id={`${fieldId}-org`}
                          value={org}
                          onChange={(e) => setOrg(e.target.value)}
                          placeholder="e.g. acme-inc"
                          disabled={startMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          Leave blank to create the App under your personal GitHub account instead
                          of an organization.
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
                  ) : null}

                  {entry.id === 'existing-app' ? (
                    <div className="space-y-4 px-4 py-5">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-app-id`} className="text-xs">
                          App ID
                        </Label>
                        <Input
                          id={`${fieldId}-app-id`}
                          value={appId}
                          onChange={(e) => setAppId(e.target.value)}
                          placeholder="123456"
                          disabled={appMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          On the App&apos;s GitHub settings page, under About.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-pem`} className="text-xs">
                          Private key (PEM)
                        </Label>
                        <Textarea
                          id={`${fieldId}-pem`}
                          value={appPrivateKey}
                          onChange={(e) => setAppPrivateKey(e.target.value)}
                          placeholder="-----BEGIN RSA PRIVATE KEY-----"
                          disabled={appMutation.isPending}
                          rows={5}
                          autoComplete="off"
                          spellCheck={false}
                          className="resize-y font-mono text-xs"
                        />
                        <p className="text-muted-foreground text-xs">
                          The whole file, including both header lines. Stored encrypted and never
                          shown again.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-installation-id`} className="text-xs">
                          Installation ID
                        </Label>
                        <Input
                          id={`${fieldId}-installation-id`}
                          value={appInstallationId}
                          onChange={(e) => setAppInstallationId(e.target.value)}
                          placeholder="987654"
                          disabled={appMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          The last path segment of the App&apos;s installation URL:{' '}
                          <span className="font-mono">
                            github.com/settings/installations/&lt;id&gt;
                          </span>
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-client-id`} className="text-xs">
                          Client ID (optional)
                        </Label>
                        <Input
                          id={`${fieldId}-client-id`}
                          value={appClientId}
                          onChange={(e) => setAppClientId(e.target.value)}
                          placeholder="Iv1.xxxxxxxxxxxxxxxx"
                          disabled={appMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          From the App&apos;s GitHub settings page, under General →{' '}
                          &quot;Client secrets&quot;. Without this, members can&apos;t link an
                          account to this App from Kortix.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-client-secret`} className="text-xs">
                          Client secret (optional)
                        </Label>
                        <Input
                          id={`${fieldId}-client-secret`}
                          type="password"
                          value={appClientSecret}
                          onChange={(e) => setAppClientSecret(e.target.value)}
                          placeholder="Generate a new client secret on the same page"
                          disabled={appMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
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
                  ) : null}

                  {entry.id === 'pat' ? (
                    <div className="divide-border divide-y">
                      {/* Requirements first, as their own flush section: a
                            token with the wrong resource owner or repository
                            scope fails at the first project, and the failure
                            gives no hint which setting was wrong. */}
                      <div className="space-y-3 px-4 py-4">
                        <p className="text-foreground text-xs font-medium">
                          Token settings that make this work
                        </p>
                        <dl className="space-y-2 text-xs">
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              Resource owner
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              The user or org that should own project repos — must match the owner
                              field below.
                            </dd>
                          </div>
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              Repository access
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              All repositories — Kortix creates a new repo per project, so a fixed
                              repo list cannot cover future ones.
                            </dd>
                          </div>
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              Permissions
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              Administration — Read and write (create repos, manage collaborators).
                              Contents — Read and write (push, pull, branches). Metadata: Read is
                              added automatically. Nothing else.
                            </dd>
                          </div>
                        </dl>
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          Create it under GitHub → Settings → Developer settings → Fine-grained
                          tokens. Do not paste your everyday personal token. Org tokens may also
                          need approval under the org&apos;s Settings → Third-party Access →
                          Personal access tokens.
                        </p>
                      </div>

                      <div className="space-y-4 px-4 py-5">
                        <div className="space-y-1.5">
                          <Label htmlFor={`${fieldId}-pat`} className="text-xs">
                            Personal / fine-grained access token
                          </Label>
                          <Input
                            id={`${fieldId}-pat`}
                            type="password"
                            value={patToken}
                            onChange={(e) => setPatToken(e.target.value)}
                            placeholder="github_pat_..."
                            disabled={patMutation.isPending}
                            autoComplete="off"
                            spellCheck={false}
                            variant="popover"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`${fieldId}-pat-owner`} className="text-xs">
                            GitHub owner (user or org)
                          </Label>
                          <Input
                            id={`${fieldId}-pat-owner`}
                            value={patOwner}
                            onChange={(e) => setPatOwner(e.target.value)}
                            placeholder="e.g. acme-inc"
                            disabled={patMutation.isPending}
                            autoComplete="off"
                            spellCheck={false}
                            variant="popover"
                          />
                          <p className="text-muted-foreground text-xs">
                            Must match the token&apos;s resource owner exactly.
                          </p>
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
                    </div>
                  ) : null}
                </DisclosureContent>
              </Disclosure>
            ))}
          </RadioGroup>
        </div>
      ) : (
        <div className="bg-popover overflow-hidden rounded-md border">
          {/* Identity: who owns the repositories Kortix is about to create. */}
          <div className="flex items-start gap-3 px-4 py-4">
            <span
              aria-hidden
              className="bg-muted/40 text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm border"
            >
              <Github className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">
                {status.owner ?? 'Managed GitHub'}
              </p>
              <p className="text-muted-foreground text-pretty text-xs leading-relaxed">
                {status.source === 'pat'
                  ? 'New project repositories are created under this owner with the stored access token.'
                  : 'New project repositories are created under this account by the GitHub App.'}
              </p>
            </div>
          </div>

          {/* Facts: one label per value, so nothing floats unexplained. */}
          <dl className="border-border grid gap-x-8 gap-y-4 border-t px-4 py-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">Authentication</dt>
              <dd className="text-foreground mt-1 truncate text-xs font-medium">
                {methodLabel(status.source)}
              </dd>
            </div>
            {status.slug ? (
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">GitHub App</dt>
                <dd className="mt-1">
                  <a
                    href={`https://github.com/apps/${status.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:text-muted-foreground inline-flex max-w-full items-center gap-1 font-mono text-xs transition-colors"
                  >
                    <span className="truncate">{status.slug}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </dd>
              </div>
            ) : null}
            {status.installation_id ? (
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">Installation</dt>
                <dd className="text-foreground mt-1 truncate font-mono text-xs tabular-nums">
                  {status.installation_id}
                </dd>
              </div>
            ) : null}
            {!status.oauth_configured ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground text-xs">Account linking</dt>
                <dd className="text-muted-foreground mt-1 text-pretty text-xs leading-relaxed">
                  No OAuth client configured for this App — members can&apos;t use &quot;Continue
                  with GitHub&quot; to link an existing installation to their account. Add a Client
                  ID and secret via Reconfigure, or set
                  KORTIX_GITHUB_APP_CLIENT_ID/KORTIX_GITHUB_APP_CLIENT_SECRET.
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="border-border border-t px-4 py-3">
            {status.source === 'env' ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                Configured by environment variables on the server. Change or remove this connection
                by updating those variables and restarting the API.
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
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

/** Title + status badges + one line of what managed-git does, with an optional
 *  right-hand action. Shared by the loaded card and the error state so both
 *  read as the same panel rather than two unrelated blocks. */
function CardHeading({
  badges,
  description = 'Every Kortix project is a git repository the server creates and pushes to on your behalf.',
  action,
}: {
  badges?: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground flex flex-wrap items-center gap-2 text-sm font-medium">
          Managed GitHub
          {badges}
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{description}</p>
      </div>
      {action}
    </div>
  );
}
