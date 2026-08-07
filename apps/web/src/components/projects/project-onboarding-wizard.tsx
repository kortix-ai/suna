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
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import { isConnectorsEnabled } from '@/lib/config';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { listConnectors } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

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

  const reduced = useReducedMotion() ?? false;
  const stepVariants = useMemo(() => slideVariants(reduced), [reduced]);

  const [calOpen, setCalOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const { answers, save } = useOnboardingAnswers(projectId);
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
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    enabled: isPending,
    ...contract('config'),
    refetchOnWindowFocus: false,
  });
  const connectorSlugs = useMemo(
    () => (connectors.data?.connectors ?? []).map((connector) => connector.slug),
    [connectors.data],
  );
  const refreshConnectors = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
  }, [queryClient, projectId]);

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
  const complete = useCallback(() => onboarding.complete(), [onboarding]);

  // Picking a starting point on the finish step seeds the project-home composer
  // and closes the wizard in one action. `composer-prefill-store` is the
  // existing one-shot handoff (project-home consumes and clears it on mount) —
  // the same channel the command palette and "try this" deep links use.
  const startWithPrompt = useCallback(
    (prompt: string) => {
      useComposerPrefillStore.getState().setPrefill(projectId, prompt);
      void complete();
    },
    [projectId, complete],
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
            {/* The entire chrome: a back control on the left, progress centred.
              No mark, no title. Nothing here competes with the question. */}
            <div className="relative flex h-14 shrink-0 items-center px-4 ">
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
              <div className="pointer-events-none absolute inset-x-0 flex justify-center">
                <StepProgress total={steps.length} current={index} />
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
                        projectId={projectId}
                        existingSlugs={connectorSlugs}
                        onConnected={refreshConnectors}
                        onContinue={next}
                        onSkip={next}
                      />
                    )}
                    {stepId === 'slack' && (
                      <SlackStep projectId={projectId} onContinue={next} onSkip={next} />
                    )}
                    {stepId === 'plan' && <PlanStep onContinue={next} />}
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
