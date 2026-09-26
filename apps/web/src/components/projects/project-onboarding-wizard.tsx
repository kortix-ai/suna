'use client';

import { useTranslations } from '@/i18n/use-translations';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m, useReducedMotion, type Variants } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { DesktopCloseButton } from '@/components/desktop/desktop-close-button';
import { Button } from '@/components/ui/button';
import { Modal, ModalContent } from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { isConnectorsEnabled } from '@/lib/config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { useFirstChatStore } from '@/stores/first-chat-store';
import { listConnectors, type OnboardingUseCase } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { completeThenNotify } from './onboarding/complete-then';
import { connectApp, connectionSlugFor, type CatalogApp } from './onboarding/connect-app';
import { slideVariants } from './onboarding/motion';
import { buildSteps, deriveCompanyDomain } from './onboarding/onboarding-profile';
import { StepIdentityProvider, StepProgress } from './onboarding/step-shell';
import { AppsStep, type AppConnectionState } from './onboarding/steps/apps-step';
import { PlanStep } from './onboarding/steps/plan-step';
import { WorkStep } from './onboarding/steps/work-step';
import { useOnboardingAnswers } from './onboarding/use-onboarding-answers';

interface AppConnection {
  connectorSlug: string;
  /** The connector exists, so a retry signs in without adding another. */
  created: boolean;
  state: AppConnectionState;
}

function AnimatedStep({
  children,
  direction,
  variants,
  idPrefix,
  ref,
}: {
  children: ReactNode;
  direction: number;
  variants: Variants;
  idPrefix: string;
  // popLayout measures the exiting step through this ref. Without it the
  // outgoing step is never popped out of flow, the centred flex container
  // lays both steps out as one stack during the swap, and the content visibly
  // drops, then jumps back up when the exit unmounts.
  ref?: Ref<HTMLDivElement>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  return (
    <m.div
      ref={(node) => {
        frameRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      custom={direction}
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      onAnimationComplete={(definition) => {
        if (definition !== 'center') return;
        frameRef.current?.querySelector<HTMLElement>('[data-onboarding-step-title]')?.focus();
      }}
    >
      <StepIdentityProvider idPrefix={idPrefix}>{children}</StepIdentityProvider>
    </m.div>
  );
}

export function ProjectOnboardingWizard({
  projectId,
  onCompleted,
  onSkip,
}: {
  projectId: string;
  /**
   * Called once onboarding has finished — after the completion stamp has been
   * attempted, whether or not it succeeded (see `completeThenNotify`).
   * `project-shell.tsx` passes nothing: there the wizard simply disappears in
   * place, which is the behaviour that shipped.
   */
  onCompleted?: () => void;
  /**
   * When supplied, renders a "Skip for now" control. Skipping STAMPS the
   * project onboarded, exactly like finishing — see `skip` below for why the
   * "leave it unstamped and catch them later" design could not work. Absent on
   * the project shell, where there is nowhere to skip TO: the wizard is already
   * the thing standing between the user and their workspace.
   */
  onSkip?: () => void;
}) {
  const t = useTranslations('projectOnboarding');
  const { user } = useAuth();

  const onboarding = useProjectOnboarding(projectId);
  const queryClient = useQueryClient();
  const router = useRouter();

  // A host that navigates on exit (`/new`) always lands on the project page.
  // Fetching that route while the questions are answered means the last click
  // swaps pages at once instead of loading one.
  const navigatesOnExit = Boolean(onCompleted || onSkip);
  useEffect(() => {
    if (navigatesOnExit) router.prefetch(`/projects/${encodeURIComponent(projectId)}`);
  }, [navigatesOnExit, projectId, router]);

  const reduced = useReducedMotion() ?? false;
  const stepVariants = useMemo(() => slideVariants(reduced), [reduced]);

  const [index, setIndex] = useState(0);
  // Set when an exit navigates away (`/new`). The stamp is optimistic, so
  // `isPending` flips false in the same tick as the click; without this the
  // wizard would unmount and uncover `/new`'s "Creating …" loader until the
  // project page paints. The route change unmounts the wizard instead.
  const [leaving, setLeaving] = useState(false);

  const { save } = useOnboardingAnswers(projectId);
  const [useCase, setUseCase] = useState<OnboardingUseCase | null>(null);
  const [note, setNote] = useState('');
  // Keyed by catalogue app slug. Held here, not in the step, so Back and
  // Continue keep what was connected.
  const [connections, setConnections] = useState<Record<string, AppConnection>>({});

  const connectorsEnabled = isConnectorsEnabled();
  // Both leaves in one batched probe — this component mounts on every project
  // load, so two singular `/effective` GETs here are two on every load.
  const caps = useProjectPageCans(projectId);
  // `project.connector.read` is manager-tier (#6522). Without it the apps step
  // cannot load anything — see `buildSteps`. Hide it on a RECEIVED denial
  // only, so a slow probe never shortens the wizard for someone who does hold
  // the leaf.
  const canReadConnectors = caps[PROJECT_ACTIONS.PROJECT_CONNECTOR_READ]?.allowed !== false;
  const steps = useMemo(
    () => buildSteps(connectorsEnabled, canReadConnectors),
    [connectorsEnabled, canReadConnectors],
  );
  const stepId = steps[index] ?? 'work';

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
    Promise.resolve()
      .then(() => resetFn())
      .then(() => {
        setIndex(0);
        successToast(t('resetSuccess'));
      })
      .catch((err) => errorToast(err instanceof Error ? err.message : String(err)));
    url.searchParams.delete('onboarding-reset');
    window.history.replaceState(null, '', url.toString());
  }, [resetHydrated, resetFn, t]);

  // Who this wizard is FOR: someone who can set the project up. Every step
  // writes something a plain project member cannot — the company domain and
  // the completion stamp both go through `PATCH /projects/:id/onboarding`,
  // which loads the project with `'write'` and 404s otherwise.
  //
  // That last one is why this is a hard gate rather than a per-step one: with
  // no way to stamp the project onboarded, `onboarding.complete()` failed for
  // a member, so the wizard re-opened full-screen on EVERY project load, over
  // a workspace they were invited into and can otherwise use. Members are
  // onboarded by whoever invited them, not by this flow.
  //
  // `=== false` — an unresolved probe leaves the wizard mounted, so the person
  // who just created the project never watches it appear a beat late.
  const cannotSetUpProject = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === false;

  const isPending = onboarding.hydrated && onboarding.status === 'pending' && !cannotSetUpProject;
  const connectors = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    // `GET /connectors/projects/:id/connectors` asserts project.connector.read
    // — do not fire it for a caller the probe already said no to.
    enabled: isPending && canReadConnectors,
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const connectorSlugs = useMemo(
    () => (connectors.data?.connectors ?? []).map((connector) => connector.slug),
    [connectors.data],
  );

  // The company domain is no longer asked. A work email already says it, so it
  // is saved once, silently. A consumer inbox yields '' and saves nothing.
  const domainSavedRef = useRef(false);
  useEffect(() => {
    if (!isPending || domainSavedRef.current) return;
    domainSavedRef.current = true;
    const domain = deriveCompanyDomain(user?.email);
    if (domain) save({ company_domain: domain });
  }, [isPending, user?.email, save]);

  // Direction drives the slide. Without it, Back and Continue animate
  // identically and the motion lies about which way the user moved.
  const [direction, setDirection] = useState(1);
  const goTo = useCallback(
    (resolve: (i: number) => number) => {
      const target = resolve(index);
      setDirection(target >= index ? 1 : -1);
      setIndex(target);
    },
    [index],
  );

  const next = useCallback(
    () => goTo((i) => Math.min(i + 1, steps.length - 1)),
    [goTo, steps.length],
  );
  const back = useCallback(() => goTo((i) => Math.max(i - 1, 0)), [goTo]);
  // Both exits land on the project's first chat (`first-chat-store.ts`): a
  // calm welcome and an idle composer. Nothing is sent for the person.
  const startFirstChat = useCallback(() => {
    useFirstChatStore.getState().start(projectId);
  }, [projectId]);

  const patchConnection = useCallback((appSlug: string, patch: Partial<AppConnection>) => {
    setConnections((current) => {
      const existing = current[appSlug];
      return existing ? { ...current, [appSlug]: { ...existing, ...patch } } : current;
    });
  }, []);

  // Synchronous up to the popup: `connectApp` opens it before any await.
  const connect = useCallback(
    (app: CatalogApp) => {
      const current = connections[app.slug];
      if (current && current.state !== 'idle') return;
      const taken = [...connectorSlugs, ...Object.values(connections).map((c) => c.connectorSlug)];
      const connectorSlug = connectionSlugFor(app, current?.connectorSlug, taken);
      const created = current?.created ?? false;
      setConnections((all) => ({
        ...all,
        [app.slug]: { connectorSlug, created, state: 'connecting' },
      }));
      connectApp({ projectId, app, connectorSlug, created }, undefined, () =>
        patchConnection(app.slug, { created: true }),
      )
        .then(() => patchConnection(app.slug, { state: 'connected' }))
        .catch((error: unknown) => {
          patchConnection(app.slug, { state: 'idle' });
          const message = error instanceof Error ? error.message : String(error);
          // Closing the popup is the person changing their mind, not a failure.
          if (!/popup closed/i.test(message)) errorToast(message);
        })
        .finally(() => {
          for (const queryKey of connectorConnectionQueryKeys(projectId)) {
            void queryClient.invalidateQueries({ queryKey });
          }
        });
    },
    [projectId, connections, connectorSlugs, patchConnection, queryClient],
  );
  const connectionStateOf = useCallback(
    (appSlug: string): AppConnectionState => connections[appSlug]?.state ?? 'idle',
    [connections],
  );
  const connectedCount = Object.values(connections).filter((c) => c.state === 'connected').length;

  // ONE finishing exit: the models step's primary and "Decide later" both
  // come through here, so `onCompleted` needs exactly one wrapping site.
  const complete = useCallback(
    () => completeThenNotify(() => onboarding.complete(), onCompleted),
    [onboarding, onCompleted],
  );

  // Skipping STAMPS, exactly like finishing. It used to leave the project
  // unstamped on the theory that the project shell's copy of this wizard would
  // "catch the user later" — but that copy reads the SAME `qk.project.detail`
  // entry this one just warmed, so it reopened the instant the user landed,
  // with no skip control, `showCloseButton={false}`,
  // `closeOnOutsideClick={false}` and Escape intercepted. Skipping was strictly
  // worse than not skipping. Stamping is what makes "Skip for now" mean what it
  // says.
  const skip = useCallback(() => {
    startFirstChat();
    if (onSkip) setLeaving(true);
    return completeThenNotify(() => onboarding.complete(), onSkip);
  }, [startFirstChat, onboarding, onSkip]);

  const openProject = useCallback(() => {
    startFirstChat();
    if (onCompleted) setLeaving(true);
    void complete();
  }, [startFirstChat, onCompleted, complete]);

  const saveWork = useCallback(() => {
    if (!useCase) return;
    const trimmed = note.trim();
    save(
      useCase === 'other' && trimmed
        ? { use_case: useCase, use_case_note: trimmed }
        : { use_case: useCase },
    );
    next();
  }, [useCase, note, save, next]);

  if (!isPending && !leaving) return null;

  return (
    <>
      <Modal open>
        <ModalContent
          side="fullscreen"
          animation="none"
          showCloseButton={false}
          closeOnOutsideClick={false}
          overlayClassName="bg-muted/30 fixed inset-0 backdrop-blur-none"
          className="border-border bg-background! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none! translate-x-0! translate-y-0! gap-0! space-y-0! overflow-hidden! rounded-none! border-0! md:inset-2! md:h-auto! md:min-h-0! md:rounded-md! md:border!"
          aria-labelledby={`onboarding-${stepId}-title`}
          aria-describedby={`onboarding-${stepId}-description`}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (index > 0) back();
          }}
        >
          <div className="flex h-full flex-col overflow-hidden">
            {/* The entire chrome: a back control on the left, progress centred,
              the skip escape hatch on the right. No mark, no title. Nothing here
              competes with the question.

              THREE COLUMNS IN FLOW, not a centred overlay. The progress used to be
              `absolute inset-x-0` at a fixed 200px, so on a 375px screen it ran
              x≈87→287 while "Skip for now" started at x≈264 — ~23px of overlap,
              ~51px at 320px. `pointer-events-none` meant clicks still landed, so it
              failed silently as a visual collision rather than a broken control.
              Grid tracks cannot overlap: `1fr auto 1fr` keeps the progress optically
              centred (both side tracks are equal) while each control reserves its
              own space at every width. Do not go back to absolute centring.

              On desktop `.kx-titlebar-spacer` above the bar drops it below the
              title-bar band: the macOS traffic lights otherwise cover the Back
              arrow. */}
            <div className="kx-titlebar-spacer" aria-hidden />
            <div className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:px-4">
              <div className="flex justify-start">
                {index > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('back')}
                    className="text-muted-foreground hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100"
                    onClick={back}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                )}
              </div>

              <StepProgress total={steps.length} current={index} />

              <div className="flex items-center justify-end gap-2">
                {/* Muted at rest — an escape hatch, never a call to action competing
                    with the step's own primary button.

                    `magic-sm` is the design system's responsive size (h-9 on touch,
                    h-8 from `sm`), so the tap target does not shrink to the desktop
                    height on a phone. The label shortens too: at 320px each side
                    track gets ~80px, and "Skip for now" needs ~110px with padding
                    while "Skip" needs ~58px. `aria-label` carries the full phrase at
                    every width, so the short label never reaches assistive tech. */}
                {onSkip && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="magic-sm"
                    aria-label={t('skipForNow')}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={skip}
                  >
                    <span className="sm:hidden">{t('skip')}</span>
                    <span className="hidden sm:inline">{t('skipForNow')}</span>
                  </Button>
                )}
                {/* Desktop only, and on every host: the shell has no browser
                    toolbar, and the project shell passes no `onSkip`. Closing
                    stamps onboarding through `skip` — an unstamped close would
                    reopen the wizard on the next project load. */}
                <DesktopCloseButton onClose={skip} />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 md:px-8">
              <div
                className="w-full max-w-[520px] pt-8"
                style={{
                  paddingBottom: 'max(calc(var(--spacing) * 8), env(safe-area-inset-bottom, 0px))',
                }}
              >
                {/* popLayout, not wait: `wait` runs the exit to completion before
                  the enter starts, which doubled every step to ~440ms of dead
                  air. popLayout takes the outgoing step out of flow so the two
                  overlap and the swap reads as one movement. */}
                <AnimatePresence mode="popLayout" custom={direction} initial={false}>
                  <AnimatedStep
                    key={stepId}
                    direction={direction}
                    variants={stepVariants}
                    idPrefix={`onboarding-${stepId}`}
                  >
                    {stepId === 'work' && (
                      <WorkStep
                        value={useCase}
                        note={note}
                        onValueChange={setUseCase}
                        onNoteChange={setNote}
                        onContinue={saveWork}
                      />
                    )}
                    {stepId === 'apps' && (
                      <AppsStep
                        projectId={projectId}
                        stateOf={connectionStateOf}
                        connectedCount={connectedCount}
                        onConnect={connect}
                        onContinue={next}
                      />
                    )}
                    {stepId === 'models' && (
                      <PlanStep projectId={projectId} onContinue={openProject} />
                    )}
                  </AnimatedStep>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </ModalContent>
      </Modal>
    </>
  );
}
