'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const setupMethods = useLocalizedUiCatalog(SETUP_METHODS);
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
    successToast(tI18nComplete.raw('text62cbe80fb119'));
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
        errorToast(tI18nComplete.raw('textf2c3996c2fc5'), {
          description: tI18nComplete.raw('text378665754d2d'),
        });
        return;
      }
      // eslint-disable-next-line no-console
      console.debug('[github-app] submitting manifest to GitHub:', manifest);
      submitManifestForm(github_create_url, state, manifest);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text1db8b5fa8eb7')),
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
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text66caa493b364')),
  });

  const patMutation = useMutation({
    mutationFn: () => setGitHubAppPat({ token: patToken.trim(), owner: patOwner.trim() }),
    onSuccess: () => {
      setPatToken('');
      setPatOwner('');
      onSetupSuccess('GitHub token connected');
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text6b4d673c26ae')),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectGitHubApp(),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text06993786f49e'));
      setConfirmDisconnectOpen(false);
      setReconfiguring(false);
      queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text6e9715f4f2a9')),
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
            title={tI18nComplete.raw('text4d37c559e4b7')}
            description={err?.message || undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => statusQuery.refetch()}>
                {tI18nComplete.raw('text942087cc2d41')}
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
                {tI18nComplete.raw('text22965568d22a')}
              </Badge>
            ) : (
              <Badge variant="muted" size="sm">
                {tI18nComplete.raw('text0303e1824670')}
              </Badge>
            )}
            {status.configured && status.source === 'env' ? (
              <Badge variant="muted" size="sm">
                {tI18nComplete.raw('text9e471951a1b4')}
              </Badge>
            ) : null}
          </>
        }
        description={
          status.configured
            ? tI18nComplete.raw('texta08beb1fae8b')
            : tI18nComplete.raw('textf4a0f0ba4a27')
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
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
          ) : null
        }
      />

      {showSetup ? (
        <div className="space-y-3">
          {reconfiguring ? (
            <InfoBanner
              tone="warning"
              icon={WarningIcon}
              title={tI18nComplete.raw('text8f0059a35e90')}
            >
              {tI18nComplete.raw('text4795dc5fb288')}
            </InfoBanner>
          ) : null}

          {/* One bordered group; the rows are its hairline-divided children, so
              nothing nests a second radius inside the first. `RadioGroup` owns
              the roving tab index, arrow-key navigation and announcement — the
              rows are `RadioGroupItem`s, not a hand-rolled selection list. */}
          <RadioGroup
            value={method}
            onValueChange={(value) => setMethod(value as SetupMethod)}
            aria-label={tI18nComplete.raw('text0a53eddc090c')}
            className="bg-popover divide-border gap-0 divide-y overflow-hidden rounded-md border"
          >
            {setupMethods.map((entry) => (
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
                          {tI18nComplete.raw('textd70604e84304')}
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
                        {tI18nComplete.raw('textfd49dcc8d164')}
                      </p>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-org`} className="text-xs">
                          {tI18nComplete.raw('text1f3073c23e1e')}
                        </Label>
                        <Input
                          id={`${fieldId}-org`}
                          value={org}
                          onChange={(e) => setOrg(e.target.value)}
                          placeholder={tI18nComplete.raw('text6f24f840d748')}
                          disabled={startMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          {tI18nComplete.raw('text49e1b64b0981')}
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
                        {startMutation.isPending
                          ? tI18nComplete.raw('text608ed1284584')
                          : tI18nComplete.raw('textd1b4e98ecd9b')}
                      </Button>
                    </div>
                  ) : null}

                  {entry.id === 'existing-app' ? (
                    <div className="space-y-4 px-4 py-5">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-app-id`} className="text-xs">
                          {tI18nComplete.raw('text3c2f1e20ab37')}
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
                          {tI18nComplete.raw('text961c25e7d44b')}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-pem`} className="text-xs">
                          {tI18nComplete.raw('text1a5ad9860afa')}
                        </Label>
                        <Textarea
                          id={`${fieldId}-pem`}
                          value={appPrivateKey}
                          onChange={(e) => setAppPrivateKey(e.target.value)}
                          placeholder={tI18nComplete.raw('text8bcac7908eb9')}
                          disabled={appMutation.isPending}
                          rows={5}
                          autoComplete="off"
                          spellCheck={false}
                          className="resize-y font-mono text-xs"
                        />
                        <p className="text-muted-foreground text-xs">
                          {tI18nComplete.raw('text8e4a53297966')}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-installation-id`} className="text-xs">
                          {tI18nComplete.raw('texta20e85bba3cf')}
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
                          {tI18nComplete.raw('textc5d595a751bb')}{' '}
                          <span className="font-mono">{tI18nComplete.raw('text2829444ea003')}</span>
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-client-id`} className="text-xs">
                          {tI18nComplete.raw('text4c9c57419990')}
                        </Label>
                        <Input
                          id={`${fieldId}-client-id`}
                          value={appClientId}
                          onChange={(e) => setAppClientId(e.target.value)}
                          placeholder={tI18nComplete.raw('text8a8dc78e312d')}
                          disabled={appMutation.isPending}
                          autoComplete="off"
                          spellCheck={false}
                          variant="popover"
                        />
                        <p className="text-muted-foreground text-xs">
                          {tI18nComplete.raw('textd515f678c881')}{' '}
                          {tI18nComplete.raw('textf93df3dc0e07')}
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-client-secret`} className="text-xs">
                          {tI18nComplete.raw('text4a93cfc32f25')}
                        </Label>
                        <Input
                          id={`${fieldId}-client-secret`}
                          type="password"
                          value={appClientSecret}
                          onChange={(e) => setAppClientSecret(e.target.value)}
                          placeholder={tI18nComplete.raw('textbde68b612323')}
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
                        {appMutation.isPending
                          ? 'Connecting'
                          : tI18nComplete.raw('textf4ea27b929c2')}
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
                          {tI18nComplete.raw('text4519df68f5f4')}
                        </p>
                        <dl className="space-y-2 text-xs">
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              {tI18nComplete.raw('textf8abf0bf6188')}
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              {tI18nComplete.raw('textde7c5922d6eb')}
                            </dd>
                          </div>
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              {tI18nComplete.raw('text3e3d7edf97ee')}
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              {tI18nComplete.raw('text76f2a71948f3')}
                            </dd>
                          </div>
                          <div className="sm:flex sm:gap-3">
                            <dt className="text-muted-foreground sm:w-[8.5rem] sm:shrink-0">
                              {tI18nComplete.raw('textabccc78cc93c')}
                            </dt>
                            <dd className="text-foreground leading-relaxed">
                              {tI18nComplete.raw('textf51ad0b730d4')}
                            </dd>
                          </div>
                        </dl>
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {tI18nComplete.raw('textfb43a788ba7b')}
                        </p>
                      </div>

                      <div className="space-y-4 px-4 py-5">
                        <div className="space-y-1.5">
                          <Label htmlFor={`${fieldId}-pat`} className="text-xs">
                            {tI18nComplete.raw('text29df79f4ec6d')}
                          </Label>
                          <Input
                            id={`${fieldId}-pat`}
                            type="password"
                            value={patToken}
                            onChange={(e) => setPatToken(e.target.value)}
                            placeholder={tI18nComplete.raw('text94238580b1b0')}
                            disabled={patMutation.isPending}
                            autoComplete="off"
                            spellCheck={false}
                            variant="popover"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`${fieldId}-pat-owner`} className="text-xs">
                            {tI18nComplete.raw('text4c53d51e3182')}
                          </Label>
                          <Input
                            id={`${fieldId}-pat-owner`}
                            value={patOwner}
                            onChange={(e) => setPatOwner(e.target.value)}
                            placeholder={tI18nComplete.raw('text6f24f840d748')}
                            disabled={patMutation.isPending}
                            autoComplete="off"
                            spellCheck={false}
                            variant="popover"
                          />
                          <p className="text-muted-foreground text-xs">
                            {tI18nComplete.raw('text1903bc11a8e9')}
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
                          {patMutation.isPending
                            ? 'Connecting'
                            : tI18nComplete.raw('textcc37009888e3')}
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
                {status.owner ?? tI18nComplete.raw('text5387a784de3a')}
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                {status.source === 'pat'
                  ? tI18nComplete.raw('text438e8341dabf')
                  : tI18nComplete.raw('text6f51d7ca1b48')}
              </p>
            </div>
          </div>

          {/* Facts: one label per value, so nothing floats unexplained. */}
          <dl className="border-border grid gap-x-8 gap-y-4 border-t px-4 py-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text66880d2d8216')}
              </dt>
              <dd className="text-foreground mt-1 truncate text-xs font-medium">
                {methodLabel(status.source)}
              </dd>
            </div>
            {status.slug ? (
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('texte53bb01e5503')}
                </dt>
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
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('textc3fc54aa5390')}
                </dt>
                <dd className="text-foreground mt-1 truncate font-mono text-xs tabular-nums">
                  {status.installation_id}
                </dd>
              </div>
            ) : null}
            {!status.oauth_configured ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('texte1f0d6f4fe26')}
                </dt>
                <dd className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
                  {tI18nComplete.raw('text8795b764ac98')}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="border-border border-t px-4 py-3">
            {status.source === 'env' ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {tI18nComplete.raw('textfe2edea70871')}
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReconfiguring(true)}
                >
                  {tI18nComplete.raw('text7458d4f300eb')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmDisconnectOpen(true)}
                >
                  {tI18nComplete.raw('textacfc5be785a9')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnectOpen}
        onOpenChange={setConfirmDisconnectOpen}
        title={tI18nComplete.raw('text45380e17ca1a')}
        description={tI18nComplete.raw('text78d14cc87b89')}
        confirmLabel={tI18nComplete.raw('textacfc5be785a9')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground flex flex-wrap items-center gap-2 text-sm font-medium">
          {tI18nComplete.raw('text5387a784de3a')}
          {badges}
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{description}</p>
      </div>
      {action}
    </div>
  );
}
