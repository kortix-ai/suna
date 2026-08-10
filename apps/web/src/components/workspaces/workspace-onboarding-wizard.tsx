'use client';

import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalContent } from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { useAuth } from '@/features/providers/auth-provider';
import { useWorkspaceOnboarding } from '@/hooks/workspaces/use-workspace-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import { isConnectorsEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { listConnectors } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { completeThenNotify } from './onboarding/complete-then';
import { slideVariants } from './onboarding/motion';
import {
  buildSteps,
  deriveCompanyDomain,
  firstStepAfterSurvey,
} from './onboarding/onboarding-profile';
import { StepIdentityProvider, StepProgress } from './onboarding/step-shell';
import { CompanyStep } from './onboarding/steps/company-step';
import { DoneStep } from './onboarding/steps/done-step';
import { PlanStep } from './onboarding/steps/plan-step';
import { SlackStep } from './onboarding/steps/slack-step';
import { ToolsStep } from './onboarding/steps/tools-step';
import { UseCaseStep } from './onboarding/steps/use-case-step';
import { useOnboardingAnswers } from './onboarding/use-onboarding-answers';

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-onboarding-wizard';

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
    <motion.div
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
    </motion.div>
  );
}

export function WorkspaceOnboardingWizard({
  workspaceId,
  onCompleted,
  onSkip,
}: {
  workspaceId: string;
  /**
   * Called once onboarding has finished — after the completion stamp has been
   * attempted, whether or not it succeeded (see `completeThenNotify`).
   * `workspace-shell.tsx` passes nothing: there the wizard simply disappears in
   * place, which is the behaviour that shipped.
   */
  onCompleted?: () => void;
  /**
   * When supplied, renders a "Skip for now" control. Skipping STAMPS the
   * project onboarded, exactly like finishing — see `skip` below for why the
   * "leave it unstamped and catch them later" design could not work. Absent on
   * the workspace shell, where there is nowhere to skip TO: the wizard is already
   * the thing standing between the user and their workspace.
   */
  onSkip?: () => void;
}) {
  const contactTier = usePersonalContactTier();
  const showFounderStep = contactTier === 'personal';
  const { user } = useAuth();
  const defaultName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    '';
  const defaultEmail = user?.email ?? '';

  const onboarding = useWorkspaceOnboarding(workspaceId);
  const queryClient = useQueryClient();

  const reduced = useReducedMotion() ?? false;
  const stepVariants = useMemo(() => slideVariants(reduced), [reduced]);

  const [calOpen, setCalOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const { answers, save } = useOnboardingAnswers(workspaceId);
  // Prefilled once from the signup email, then owned by the user. A lazy
  // initializer, not an effect — an effect would re-run and clobber typing.
  const [domain, setDomain] = useState(() => deriveCompanyDomain(user?.email));

  const connectorsEnabled = isConnectorsEnabled();
  const steps = useMemo(() => buildSteps(connectorsEnabled), [connectorsEnabled]);
  const stepId = steps[index] ?? 'use-case';

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
        successToast('Onboarding reset');
      })
      .catch((err) => errorToast(err instanceof Error ? err.message : String(err)));
    url.searchParams.delete('onboarding-reset');
    window.history.replaceState(null, '', url.toString());
  }, [resetHydrated, resetFn]);

  const isPending = onboarding.hydrated && onboarding.status === 'pending';
  const connectors = useQuery({
    queryKey: qk.workspace.connectors(workspaceId),
    queryFn: () => listConnectors(workspaceId),
    enabled: isPending,
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const connectorSlugs = useMemo(
    () => (connectors.data?.connectors ?? []).map((connector) => connector.slug),
    [connectors.data],
  );
  const refreshConnectors = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: qk.workspace.connectors(workspaceId) });
  }, [queryClient, workspaceId]);

  // Direction drives the slide. Without it, Back and Continue animate
  // identically and the motion lies about which way the user moved.
  const [direction, setDirection] = useState(1);
  const goTo = useCallback((resolve: (i: number) => number) => {
    setIndex((i) => {
      const target = resolve(i);
      setDirection(target >= i ? 1 : -1);
      return target;
    });
  }, []);

  const next = useCallback(
    () => goTo((i) => Math.min(i + 1, steps.length - 1)),
    [goTo, steps.length],
  );
  const back = useCallback(() => goTo((i) => Math.max(i - 1, 0)), [goTo]);
  // ONE exit for the whole wizard: `startWithPrompt` and `DoneStep`'s `onStart`
  // both come through here, so `onCompleted` needs exactly one wrapping site.
  // `skipSurvey` below is NOT an exit — it moves between steps.
  const complete = useCallback(
    () => completeThenNotify(() => onboarding.complete(), onCompleted),
    [onboarding, onCompleted],
  );

  // Skipping STAMPS, exactly like finishing. It used to leave the workspace
  // unstamped on the theory that the workspace shell's copy of this wizard would
  // "catch the user later" — but that copy reads the SAME `qk.workspace.detail`
  // entry this one just warmed, so it reopened the instant the user landed,
  // with no skip control, `showCloseButton={false}`,
  // `closeOnOutsideClick={false}` and Escape intercepted. Skipping was strictly
  // worse than not skipping. Stamping is what makes "Skip for now" mean what it
  // says.
  const skip = useCallback(
    () => completeThenNotify(() => onboarding.complete(), onSkip),
    [onboarding, onSkip],
  );

  // Picking a starting point on the finish step seeds the workspace-home composer
  // and closes the wizard in one action. `composer-prefill-store` is the
  // existing one-shot handoff (workspace-home consumes and clears it on mount) —
  // the same channel the command palette and "try this" deep links use.
  const startWithPrompt = useCallback(
    (prompt: string) => {
      useComposerPrefillStore.getState().setPrefill(workspaceId, prompt);
      void complete();
    },
    [workspaceId, complete],
  );

  // Skipping the survey jumps past BOTH questions to whatever comes next —
  // `tools` normally, `slack` when connectors are disabled.
  const skipSurvey = useCallback(() => goTo(() => firstStepAfterSurvey(steps)), [goTo, steps]);

  if (!isPending) return null;

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
              own space at every width. Do not go back to absolute centring. */}
            <div className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:px-4">
              <div className="flex justify-start">
                {index > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Back"
                    className="text-muted-foreground hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100"
                    onClick={back}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                )}
              </div>

              <StepProgress total={steps.length} current={index} />

              <div className="flex justify-end">
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
                    aria-label="Skip for now"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={skip}
                  >
                    <span className="sm:hidden">Skip</span>
                    <span className="hidden sm:inline">Skip for now</span>
                  </Button>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 md:px-8">
              <div className="w-full max-w-[520px] pt-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
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
                    {stepId === 'use-case' && (
                      <UseCaseStep
                        value={answers.use_case ?? null}
                        onSelect={(v) => save({ use_case: v })}
                        onContinue={next}
                        onSkip={skipSurvey}
                      />
                    )}
                    {stepId === 'company' && (
                      <CompanyStep
                        domain={domain}
                        size={answers.company_size ?? null}
                        onDomainChange={setDomain}
                        onSizeChange={(v) => save({ company_size: v })}
                        onContinue={() => {
                          // The domain is free text, so it saves on Continue
                          // rather than per keystroke.
                          const trimmed = domain.trim();
                          if (trimmed && trimmed !== answers.company_domain) {
                            save({ company_domain: trimmed });
                          }
                          next();
                        }}
                        onSkip={skipSurvey}
                      />
                    )}
                    {stepId === 'tools' && (
                      <ToolsStep
                        workspaceId={workspaceId}
                        existingSlugs={connectorSlugs}
                        onConnected={refreshConnectors}
                        onContinue={next}
                        onSkip={next}
                      />
                    )}
                    {stepId === 'slack' && (
                      <SlackStep workspaceId={workspaceId} onContinue={next} onSkip={next} />
                    )}
                    {stepId === 'plan' && <PlanStep workspaceId={workspaceId} onContinue={next} />}
                    {stepId === 'done' && (
                      <DoneStep
                        useCase={answers.use_case ?? null}
                        profileCount={connectorSlugs.length}
                        showFounderCall={showFounderStep}
                        onBookCall={() => setCalOpen(true)}
                        onStart={complete}
                        onUsePrompt={startWithPrompt}
                      />
                    )}
                  </AnimatedStep>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </ModalContent>
      </Modal>

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
