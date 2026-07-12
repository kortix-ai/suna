'use client';

/**
 * Project onboarding — a full-screen, guided setup flow for a brand-new project.
 *
 * Conversion-first: instead of an informational modal, this walks the user
 * through the few things that actually make Kortix useful, and confirms each
 * one happened along the way:
 *
 *   1. Welcome / book a call   — a warm start (founder concierge when eligible).
 *   2. Connect your tools      — pick the apps you live in and authorize them
 *                                right here (real Pipedream OAuth, inline).
 *   3. Install to Slack        — one-click install, then we POLL for the install
 *                                and flip to a confirmed ✓ the moment it lands.
 *                                Gated (can't "Continue" until connected) with a
 *                                quiet "Skip for now" escape hatch.
 *   4. You're all set          — recap + into the product.
 *
 * Self-gates: only renders while the project's onboarding status is 'pending'
 * (no `metadata.onboarding_completed_at`). Heavy deps (the Pipedream browser
 * SDK, the custom-Slack manifest form) are loaded on demand so the always-
 * mounted wizard adds ~nothing to the project bundle until it actually opens.
 *
 * NOTE: copy here is plain English. The repo's hardcoded-UI i18n keys still need
 * to be generated for these strings before this ships beyond local testing.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Image from 'next/image';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { useAuth } from '@/features/providers/auth-provider';
import { useSlackInstall, useSlackMode } from '@/hooks/channels/use-channels-installations';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import {
  listConnectors,
  listPipedreamApps,
  type PipedreamApp,
} from '@kortix/sdk/projects-client';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-onboarding-wizard';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

/** Slack has its own dedicated step, so keep it out of the tools grid. */
const SLACK_SLUGS = new Set(['slack', 'slack_v2']);

/** Lazy — keeps the giant connectors-view module out of the project bundle. */
const SlackConnectForm = lazy(() =>
  import('@/features/workspace/customize/sections/connectors-view').then((m) => ({
    default: m.SlackConnectForm,
  })),
);

/** Lazy — the full custom-connector form (OpenAPI / GraphQL / MCP / HTTP), reused
 * verbatim from the Connectors page so onboarding's "Advanced" tab matches it. */
const CustomConnectorForm = lazy(() =>
  import('@/features/workspace/customize/sections/connectors-view').then((m) => ({
    default: m.CustomConnectorForm,
  })),
);

type StepId = 'welcome' | 'tools' | 'slack' | 'done';

// ─── Shell ────────────────────────────────────────────────────────────────────

export function ProjectOnboardingWizard({ projectId }: { projectId: string }) {
  const contactTier = usePersonalContactTier();
  const showFounderStep = contactTier === 'personal';
  const { user } = useAuth();
  const defaultName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    '';
  const defaultEmail = user?.email ?? '';

  const onboarding = useProjectOnboarding(projectId);
  const queryClient = useQueryClient();

  const [calOpen, setCalOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const steps = useMemo<StepId[]>(() => ['welcome', 'tools', 'slack', 'done'], []);
  const stepId = steps[index] ?? 'welcome';

  // `?onboarding-reset` reopens the wizard from the top (clears completion flag).
  const resetFn = onboarding.reset;
  const resetHydrated = onboarding.hydrated;
  const resetFiredRef = useRef(false);
  useEffect(() => {
    if (!resetHydrated || resetFiredRef.current) return;
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('onboarding-reset')) return;
    resetFiredRef.current = true;
    setIndex(0);
    Promise.resolve()
      .then(() => resetFn())
      .then(() => toast.success('Onboarding reset'))
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    url.searchParams.delete('onboarding-reset');
    window.history.replaceState(null, '', url.toString());
  }, [resetHydrated, resetFn]);

  const isPending = onboarding.hydrated && onboarding.status === 'pending';
  const connectors = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    enabled: isPending,
    ...Q,
  });
  const connectedSlugs = useMemo(
    () => new Set((connectors.data?.connectors ?? []).filter((c) => c.secretSet).map((c) => c.slug)),
    [connectors.data],
  );
  const refreshConnectors = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['project-connectors', projectId] });
  }, [queryClient, projectId]);

  const shouldRender = isPending;

  const next = useCallback(
    () => setIndex((i) => Math.min(i + 1, steps.length - 1)),
    [steps.length],
  );
  const back = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const complete = useCallback(() => onboarding.complete(), [onboarding]);

  if (!shouldRender) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-background fixed inset-0 z-[70] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Project setup"
      >
        {/* Top bar — brand + progress. Skipping lives in the footer, per step,
            next to Continue — not as a corner escape hatch. */}
        <div className="relative flex items-center px-5 py-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <KortixAsterisk index={0} />
            <span className="text-foreground text-sm font-semibold tracking-tight">Set up your project</span>
          </div>
          <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1.5 md:flex">
            {steps.map((s, i) => (
              <span
                key={s}
                className={cn(
                  'h-1 rounded-full transition-all duration-300',
                  i < index ? 'bg-foreground/60 w-8' : i === index ? 'bg-foreground w-8' : 'bg-foreground/15 w-8',
                )}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-5 pb-6 md:items-center md:px-8">
          <div className="w-full max-w-2xl py-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={stepId}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                {stepId === 'welcome' && (
                  <WelcomeStep
                    showFounderStep={showFounderStep}
                    onBookCall={() => setCalOpen(true)}
                    onContinue={next}
                  />
                )}
                {stepId === 'tools' && (
                  <ToolsStep
                    projectId={projectId}
                    connectedSlugs={connectedSlugs}
                    onConnected={refreshConnectors}
                  />
                )}
                {stepId === 'slack' && <SlackStep projectId={projectId} />}
                {stepId === 'done' && (
                  <DoneStep
                    connectedCount={connectedSlugs.size}
                    onStart={complete}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Footer */}
        {stepId !== 'done' && (
          <div className="border-border/60 bg-muted/20 flex items-center justify-between border-t px-5 py-3.5 md:px-8">
            <div>
              {index > 0 && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={back}>
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              )}
            </div>
            <StepPrimaryAction stepId={stepId} projectId={projectId} onNext={next} />
          </div>
        )}
      </motion.div>

      {showFounderStep && (
        <DemoQualifierModal
          open={calOpen}
          onOpenChange={setCalOpen}
          calLink={CAL_LINK}
          calNamespace={CAL_NAMESPACE}
          source="onboarding-wizard"
          title="Book a 20-minute setup call"
          description="A couple of focused minutes with the team to get your command center dialed in."
          defaultName={defaultName}
          defaultEmail={defaultEmail}
          onBookingSuccessful={() => setCalOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The footer's primary button is owned per-step so the Slack step can GATE it on
 * a confirmed install (via shared react-query cache) without prop-drilling state.
 */
function StepPrimaryAction({
  stepId,
  projectId,
  onNext,
}: {
  stepId: StepId;
  projectId: string;
  onNext: () => void;
}) {
  const slackInstall = useSlackInstall(stepId === 'slack' ? projectId : null);
  const slackConnected = !!slackInstall.data;

  if (stepId === 'slack') {
    return (
      <div className="flex items-center gap-3">
        {!slackConnected && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onNext}>
            Skip
          </Button>
        )}
        <Button size="sm" className="gap-1.5" onClick={onNext} disabled={!slackConnected}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </div>
    );
  }

  if (stepId === 'tools') {
    return (
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onNext}>
          Skip
        </Button>
        <Button size="sm" className="gap-1.5" onClick={onNext}>
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" className="gap-1.5" onClick={onNext}>
      Continue
      <ArrowRight className="size-4" />
    </Button>
  );
}

// ─── Step 1: Welcome / book a call ─────────────────────────────────────────────

function WelcomeStep({
  showFounderStep,
  onBookCall,
  onContinue,
}: {
  showFounderStep: boolean;
  onBookCall: () => void;
  onContinue: () => void;
}) {
  if (showFounderStep) {
    return (
      <div className="flex flex-col items-start gap-6">
        <div className="border-border/70 bg-card relative size-16 shrink-0 overflow-hidden rounded-xl border">
          <Image src="/marko.png" alt="Marko Kraemer" fill priority className="object-cover" />
        </div>
        <div className="space-y-2.5">
          <h1 className="text-foreground text-[26px] leading-tight font-semibold tracking-tight">
            Let&apos;s get your command center set up
          </h1>
          <p className="text-muted-foreground max-w-lg text-[15px] leading-7">
            I&apos;m Marko, founder of Kortix. Book a quick 20-minute call and we&apos;ll set up your
            company&apos;s AI command center together — or jump straight in and connect your tools below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" className="gap-1.5" onClick={onBookCall}>
            Book a call with Marko
          </Button>
          <Button size="lg" variant="outline" onClick={onContinue}>
            I&apos;ll set it up myself
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-6">
      <KortixAsterisk index={0} parentClass="size-9" />
      <div className="space-y-2.5">
        <h1 className="text-foreground text-[26px] leading-tight font-semibold tracking-tight">
          Welcome to Kortix
        </h1>
        <p className="text-muted-foreground max-w-lg text-[15px] leading-7">
          A few quick steps and your agent will be wired into the tools your team already runs on.
          Connect your apps, drop it into Slack, and you&apos;re off.
        </p>
      </div>
      <Button size="lg" className="gap-1.5" onClick={onContinue}>
        Get started
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

// ─── Step 2: Connect your tools ────────────────────────────────────────────────

function ToolsStep({
  projectId,
  connectedSlugs,
  onConnected,
}: {
  projectId: string;
  connectedSlugs: Set<string>;
  onConnected: () => void;
}) {
  const [q, setQ] = useState('');
  const connect = useToolConnect(projectId, onConnected);

  const appsQuery = useInfiniteQuery({
    queryKey: ['onboarding-tools', projectId, q],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });

  const apps = (appsQuery.data?.pages ?? [])
    .flatMap((p) => p.apps)
    .filter((a) => !SLACK_SLUGS.has(a.slug));
  const notConfigured =
    appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');
  const connectedCount = connectedSlugs.size;

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-foreground text-[26px] leading-tight font-semibold tracking-tight">
          Connect your tools
        </h1>
        <p className="text-muted-foreground max-w-lg text-[15px] leading-7">
          Pick the apps you live in and authorize them right here. Your agent can read, write, and act
          across everything you connect — Gmail, Notion, Salesforce, and 3,000+ more.
        </p>
      </div>

      <Tabs defaultValue="easy" className="gap-4">
        <TabsList>
          <TabsTrigger value="easy">Easy connect</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>

        {/* Easy connect — 1-click OAuth apps (Pipedream catalogue). */}
        <TabsContent value="easy" className="mt-0 flex flex-col gap-4">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search 3,000+ apps…"
              className="h-11 pl-9"
            />
          </div>

          {notConfigured ? (
            <InfoBanner tone="neutral" title="App connect isn’t configured on this deployment">
              You can still continue and connect tools later from Connectors, or use the Custom tab
              to wire up an API directly.
            </InfoBanner>
          ) : (
            <div className="max-h-[42vh] min-h-[180px] overflow-y-auto pr-1">
              {appsQuery.isLoading ? (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <Skeleton key={i} className="h-[64px] w-full rounded-xl" />
                  ))}
                </div>
              ) : apps.length === 0 ? (
                <p className="text-muted-foreground py-10 text-center text-sm">
                  {q ? `Nothing matches “${q}”.` : 'Try a search.'}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {apps.map((app) => (
                      <ToolTile
                        key={app.slug}
                        app={app}
                        connected={connectedSlugs.has(app.slug)}
                        pending={connect.isPending && connect.variables === app.slug}
                        busy={connect.isPending}
                        onConnect={() => connect.mutate(app.slug)}
                      />
                    ))}
                  </div>
                  {appsQuery.hasNextPage && (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => appsQuery.fetchNextPage()}
                        disabled={appsQuery.isFetchingNextPage}
                      >
                        {appsQuery.isFetchingNextPage ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : null}
                        Load more
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <p className="text-muted-foreground text-xs">
            {connectedCount > 0
              ? `${connectedCount} ${connectedCount === 1 ? 'tool' : 'tools'} connected — add as many as you like, then continue.`
              : 'Connect a few now, or skip and add them anytime.'}
          </p>
        </TabsContent>

        {/* Custom — wire up any OpenAPI / GraphQL / MCP / HTTP service directly. */}
        <TabsContent value="custom" className="mt-0">
          <p className="text-muted-foreground mb-3 text-sm leading-6">
            Have your own API? Connect a custom OpenAPI, GraphQL, MCP, or HTTP service so your agent
            can call it directly.
          </p>
          <div className="max-h-[46vh] overflow-y-auto pr-1">
            <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
              <CustomConnectorForm
                projectId={projectId}
                emailChannelEnabled={false}
                onAdded={() => onConnected()}
              />
            </Suspense>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ToolTile({
  app,
  connected,
  pending,
  busy,
  onConnect,
}: {
  app: PipedreamApp;
  connected: boolean;
  pending: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={connected || busy}
      aria-label={connected ? `${app.name} connected` : `Connect ${app.name}`}
      className={cn(
        'group border-border/60 bg-card flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
        connected
          ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
          : 'hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-60',
      )}
    >
      {app.imgSrc ? (
        <Image
          src={app.imgSrc}
          alt=""
          width={32}
          height={32}
          unoptimized
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-lg object-contain"
        />
      ) : (
        <EntityAvatar icon={Plus} size="sm" label={app.name} />
      )}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{app.name}</span>
        {app.categories?.[0] && (
          <span className="text-muted-foreground block truncate text-xs">{app.categories[0]}</span>
        )}
      </span>
      <span className="shrink-0">
        {pending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : connected ? (
          <Check className="size-4 text-emerald-600" />
        ) : (
          <Plus className="text-muted-foreground/40 group-hover:text-primary size-4 transition-colors" />
        )}
      </span>
    </button>
  );
}

// ─── Step 3: Install to Slack ──────────────────────────────────────────────────

function SlackStep({ projectId }: { projectId: string }) {
  const mode = useSlackMode(projectId);
  const install = useSlackInstall(projectId);
  const [waiting, setWaiting] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  const installUrl = mode.data?.oauth_available ? mode.data.install_url : null;
  const connected = !!install.data;

  // Poll for the install while we're waiting on the user to approve in Slack.
  const refetch = install.refetch;
  useEffect(() => {
    if (!waiting || connected) return;
    const id = setInterval(() => refetch(), 2500);
    return () => clearInterval(id);
  }, [waiting, connected, refetch]);

  // Once it lands, stop waiting.
  useEffect(() => {
    if (connected) setWaiting(false);
  }, [connected]);

  const openInstall = () => {
    if (!installUrl) return;
    window.open(installUrl, 'kortix-slack-install', 'width=640,height=780,noopener');
    setWaiting(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-foreground text-[26px] leading-tight font-semibold tracking-tight">
          Install Kortix into Slack
        </h1>
        <p className="text-muted-foreground max-w-lg text-[15px] leading-7">
          This is where most teams actually use Kortix. Install the app and you can @mention your agent,
          kick off tasks, and get results right inside Slack.
        </p>
      </div>

      {connected ? (
        <InfoBanner tone="success" icon={Check} title="Slack connected 🎉">
          Installed to{' '}
          <span className="font-medium">
            {install.data?.workspaceName || install.data?.workspaceId}
          </span>
          . You can @mention your agent in any channel it&apos;s invited to.
        </InfoBanner>
      ) : (
        <div className="border-border/60 bg-card flex flex-col items-center gap-4 rounded-2xl border px-6 py-10 text-center">
          <SlackGlyph />
          {waiting ? (
            <div className="flex flex-col items-center gap-2">
              <div className="text-foreground flex items-center gap-2 text-sm font-medium">
                <Loader2 className="size-4 animate-spin" />
                Waiting for you to approve in Slack…
              </div>
              <p className="text-muted-foreground max-w-sm text-xs leading-5">
                Approve the install in the window that opened. We&apos;ll detect it automatically — no
                need to come back and click anything.
              </p>
              <Button variant="ghost" size="sm" className="mt-1" onClick={openInstall}>
                Reopen Slack install
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-muted-foreground max-w-sm text-sm leading-6">
                One click — authorize Kortix in your workspace, no setup required.
              </p>
              <Button
                size="lg"
                className="gap-2"
                onClick={openInstall}
                disabled={mode.isLoading || !installUrl}
              >
                Add to Slack
                <ArrowRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Custom Slack app — fallback for self-hosted / managed install not configured. */}
      {!connected && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8 gap-1.5 px-0"
            onClick={() => setCustomOpen((o) => !o)}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', customOpen && 'rotate-180')} />
            <SlidersHorizontal className="size-3.5" />
            Use a custom Slack app instead
          </Button>
          {customOpen && (
            <div className="mt-3">
              <Suspense
                fallback={<Skeleton className="h-24 w-full rounded-2xl" />}
              >
                <SlackConnectForm projectId={projectId} onConnected={() => install.refetch()} />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SlackGlyph() {
  return (
    <span className="border-border/60 bg-background flex size-14 items-center justify-center rounded-2xl border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="https://www.google.com/s2/favicons?domain=slack.com&sz=128"
        alt=""
        width={32}
        height={32}
        className="size-8"
      />
    </span>
  );
}

// ─── Step 4: Done ──────────────────────────────────────────────────────────────

function DoneStep({ connectedCount, onStart }: { connectedCount: number; onStart: () => void }) {
  return (
    <div className="flex flex-col items-start gap-6">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/10">
        <Check className="size-7 text-emerald-600" />
      </div>
      <div className="space-y-2.5">
        <h1 className="text-foreground text-[26px] leading-tight font-semibold tracking-tight">
          You&apos;re all set
        </h1>
        <p className="text-muted-foreground max-w-lg text-[15px] leading-7">
          Your command center is ready
          {connectedCount > 0
            ? ` with ${connectedCount} ${connectedCount === 1 ? 'tool' : 'tools'} connected`
            : ''}
          . Describe a task in the composer and your agent gets to work — it can research, write, and
          act across everything you&apos;ve connected.
        </p>
      </div>
      <Button size="lg" className="gap-1.5" onClick={onStart}>
        Start building
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}
