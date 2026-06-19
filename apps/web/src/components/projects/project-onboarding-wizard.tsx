'use client';

import { faviconUrl, INTEGRATION_DOMAINS } from '@/components/home/logo-marquee';
import { Button } from '@/components/ui/button';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { DemoQualifierModal } from '@/features/contact/demo-qualifier-modal';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { usePersonalContactTier } from '@/hooks/use-show-personal-contact';
import type { CustomizeSection } from '@/lib/customize-sections';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectSessions,
} from '@/lib/projects-client';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { chalkColors } from '@kortix/shared';
import {
  Icon as IconMynauiType,
  LayersTwoSolid,
  SparklesSolid,
  UsersSolid,
} from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, MessageSquare, Plug, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-onboarding-wizard';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

const FEATURED_INTEGRATIONS = INTEGRATION_DOMAINS.slice(0, 32);

const STARTER_PROMPT_DISPLAY_DESCRIPTIONS: Record<string, string> = {
  'company-memory': 'Ask about your company, customers, and team, then save it all to memory.',
  'contract-draft': 'NDAs, MSAs, and terms of service drafted with citations.',
};

const CUSTOMIZE_BUILD_OUT_ITEMS = [
  'Agents personas shaped around how your team actually works.',
  'Skills turn the workflows you do over and over into one-line shortcuts that reach into your integrations.',
  'Commands slash shortcuts for the things you fire constantly.',
  'Automations schedules and webhooks that run work for you, no prompt needed.',
] as const;

type WizardStepId = 'founder' | 'integrations' | 'team' | 'first-request' | 'agents';

type WizardStep = {
  id: WizardStepId;
  icon: LucideIcon | IconMynauiType;
  title: string;
  description: string;
  done: boolean;
  showStarterPrompts?: boolean;
  informational?: boolean;
  primaryCta?: string;
  primaryAction?: () => void;
};

export function ProjectOnboardingWizard({ projectId }: { projectId: string }) {
  const contactTier = usePersonalContactTier();
  const showFounderStep = contactTier !== 'none';
  const { user } = useAuth();
  const defaultName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    '';
  const defaultEmail = user?.email ?? '';
  const onboarding = useProjectOnboarding(projectId);
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const customizeOpen = useCustomizeStore((s) => s.open);
  const setPrefill = useComposerPrefillStore((s) => s.setPrefill);
  const [calOpen, setCalOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [founderBooked, setFounderBooked] = useState(false);
  const [stagedPromptId, setStagedPromptId] = useState<string | null>(null);

  const resetFn = onboarding.reset;
  const resetHydrated = onboarding.hydrated;
  const resetFiredRef = useRef(false);
  useEffect(() => {
    if (!resetHydrated || resetFiredRef.current) return;
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('onboarding-reset')) return;
    resetFiredRef.current = true;
    setCurrentIndex(0);
    Promise.resolve()
      .then(() => resetFn())
      .then(() => successToast('Onboarding reset', { description: 'Wizard reopened' }))
      .catch((err) =>
        errorToast("Couldn't reset onboarding", {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
    url.searchParams.delete('onboarding-reset');
    window.history.replaceState(null, '', url.toString());
  }, [resetHydrated, resetFn]);

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    ...Q,
  });
  const connectors = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    ...Q,
  });
  const access = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    ...Q,
  });
  const sessions = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    ...Q,
  });

  const isLoading = detail.isLoading || connectors.isLoading || sessions.isLoading;

  const openSection = useCallback(
    (section: CustomizeSection) => openCustomize(section),
    [openCustomize],
  );

  const steps: WizardStep[] = useMemo(() => {
    const list: WizardStep[] = [];

    if (showFounderStep) {
      list.push({
        id: 'founder',
        icon: SparklesSolid,
        title: 'Want a hand getting started?',
        description:
          "I'm Marko, founder of Kortix. Book a 20-minute call and I'll help set up your company's AI command center with you.",
        done: founderBooked,
        primaryCta: 'Book a call with Marko',
        primaryAction: () => setCalOpen(true),
      });
    }

    const connectorCount = connectors.data?.connectors.length ?? 0;
    const memberCount = access.data?.members.length ?? 0;
    const sessionCount = sessions.data?.length ?? 0;

    list.push(
      {
        id: 'team',
        icon: UsersSolid,
        title: 'Invite your team',
        description:
          'Bring teammates in so everyone can run sessions and review what your agent ships back.',
        done: memberCount > 1,
        primaryCta: 'Invite teammates',
        primaryAction: () => openSection('members'),
      },
      {
        id: 'integrations',
        icon: Plug,
        title: 'Connect your tools',
        description:
          'Wire up the apps your agent should use — Slack, Gmail, Salesforce, Notion, and everything else your team runs on.',
        done: connectorCount > 0,
      },
      {
        id: 'first-request',
        icon: MessageSquare,
        title: 'See what you can ask',
        description:
          'Pick one example to pre-fill the composer after onboarding, or keep browsing. Your agent can do all of this and more.',
        done: sessionCount > 0,
        showStarterPrompts: true,
      },
      {
        id: 'agents',
        icon: LayersTwoSolid,
        title: 'Make it your Kortix',
        informational: true,
        done: false,
        description:
          'You start with general knowledge work skills pre-configured: research, writing, and analysis.',
      },
    );

    return list;
  }, [showFounderStep, connectors.data, access.data, sessions.data, founderBooked, openSection]);

  const totalSteps = steps.length;
  const currentStep: WizardStep | undefined = steps[currentIndex];
  const isFinalScreen = currentIndex >= totalSteps && totalSteps > 0;
  const isLastStep = !isFinalScreen && currentIndex === steps.length - 1;
  const activeDotIndex = isFinalScreen ? steps.length - 1 : currentIndex;

  const prevStepRef = useRef<{ id: string | null; done: boolean }>({
    id: null,
    done: false,
  });
  useEffect(() => {
    if (!currentStep) {
      prevStepRef.current = { id: null, done: false };
      return;
    }
    const prev = prevStepRef.current;
    if (prev.id === currentStep.id && !prev.done && currentStep.done) {
      setCurrentIndex((i) => Math.min(i + 1, totalSteps));
    }
    prevStepRef.current = { id: currentStep.id, done: currentStep.done };
  }, [currentStep, totalSteps]);

  const shouldRender =
    onboarding.hydrated && onboarding.status === 'pending' && !isLoading && totalSteps > 0;

  const advance = useCallback(() => {
    setCurrentIndex((i) => Math.min(i + 1, totalSteps));
  }, [totalSteps]);

  const goToStep = useCallback(
    (index: number) => {
      setCurrentIndex(Math.max(0, Math.min(index, totalSteps - 1)));
    },
    [totalSteps],
  );

  const isFounder = currentStep?.id === 'founder';
  const isInformational = !!currentStep?.informational;
  const StepIcon = currentStep?.icon;

  const modalTitle = isFinalScreen
    ? "You're all set"
    : (currentStep?.title ?? 'Project onboarding');
  const modalDescription = isFinalScreen
    ? 'Your command center is ready. Describe a task in the composer and your agent gets to work.'
    : (currentStep?.description ?? 'Set up your project');
  const hiddenWhileOverlayOpen = customizeOpen || calOpen;

  const chalk = chalkColors(`${currentStep?.title?.trim()}-colors` || 'onboarding-wizard');

  return (
    <>
      <Modal
        open={shouldRender}
        onOpenChange={(open) => {
          if (!open) onboarding.complete();
        }}
      >
        <ModalContent
          variant="base"
          closeOnOutsideClick={false}
          className={cn(
            'border-border/70 bg-background gap-0 space-y-0 overflow-hidden p-0 lg:max-w-xl',
            hiddenWhileOverlayOpen && 'pointer-events-none opacity-0',
          )}
          closeClassName="text-muted-foreground hover:bg-muted hover:text-foreground"
          overlayClassName={cn(hiddenWhileOverlayOpen && 'pointer-events-none opacity-0')}
          aria-hidden={hiddenWhileOverlayOpen}
        >
          <ModalTitle className="sr-only">{modalTitle}</ModalTitle>
          <ModalDescription className="sr-only">{modalDescription}</ModalDescription>

          <ModalBody className="flex min-h-[420px] flex-col space-y-0 p-6 pt-7 md:px-6">
            {isFinalScreen ? (
              <div className="flex flex-1 flex-col justify-between gap-8">
                <div className="flex flex-col items-start gap-5">
                  <div className="max-w-[460px]">
                    <h2 className="text-foreground text-[22px] leading-[1.15] font-semibold tracking-tight">
                      You&rsquo;re all set
                    </h2>
                    <p className="text-muted-foreground mt-2 text-sm leading-6">
                      Your command center is ready. Describe a task in the composer and your agent
                      gets to work.
                    </p>
                  </div>
                </div>
                <Button
                  size="lg"
                  onClick={onboarding.complete}
                  className="w-fit gap-1.5 active:scale-[0.98]"
                >
                  Start building
                  <ArrowRight />
                </Button>
              </div>
            ) : currentStep ? (
              <div className="flex flex-1 flex-col justify-between gap-8">
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col items-start gap-5">
                    {isFounder ? (
                      <div className="border-border/70 bg-card relative size-16 shrink-0 overflow-hidden rounded-lg border">
                        <Image
                          src="/marko.png"
                          alt="Marko Kraemer"
                          width={128}
                          height={128}
                          priority
                          className="size-full object-cover"
                        />
                      </div>
                    ) : null}

                    <ModalHeader className="max-w-[480px] p-0">
                      <ModalTitle className="text-[22px] leading-[1.15] tracking-tight">
                        {currentStep.title}
                      </ModalTitle>
                      <ModalDescription className="mt-2 text-sm leading-6">
                        {currentStep.description}
                      </ModalDescription>
                    </ModalHeader>
                  </div>

                  {currentStep.id === 'integrations' && (
                    <div className="flex flex-col gap-3">
                      <div className="grid grid-cols-8 gap-1.5" aria-hidden="true">
                        {FEATURED_INTEGRATIONS.map((domain) => (
                          <span
                            key={domain}
                            className="border-border bg-card flex size-14 items-center justify-center rounded-sm border"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={faviconUrl(domain)}
                              alt=""
                              width={40}
                              height={40}
                              loading="lazy"
                              decoding="async"
                              className="size-7"
                            />
                          </span>
                        ))}
                      </div>
                      <p className="text-muted-foreground text-center text-xs leading-5">
                        3,000+ integrations you can connect to — OAuth, MCP, REST, and the tools
                        your team already lives in.
                      </p>
                    </div>
                  )}

                  {currentStep.id === 'agents' && (
                    <div className="flex flex-col gap-3">
                      <p className="text-foreground text-sm leading-6 font-medium">
                        To make it truly yours, build out:
                      </p>
                      <ul className="space-y-2">
                        {CUSTOMIZE_BUILD_OUT_ITEMS.map((item, index) => (
                          <li key={item} className="flex items-start gap-2 text-sm leading-6">
                            <KortixAsterisk index={index} parentClass="mt-1.5 size-3" />
                            <p className="text-muted-foreground flex items-center gap-1 font-medium">
                              {item}
                            </p>
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground text-sm leading-6 font-medium">
                        All of it lives in your repo as code, version-controlled, and compounds week
                        over week.
                      </p>
                    </div>
                  )}

                  {currentStep.showStarterPrompts && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {STARTER_PROMPTS.map((p) => {
                        const PromptIcon = p.icon;
                        const isStaged = stagedPromptId === p.id;
                        return (
                          <Button
                            key={p.id}
                            type="button"
                            variant="secondary"
                            onClick={() => {
                              setPrefill(projectId, p.prompt);
                              setStagedPromptId(p.id);
                            }}
                            className={cn(
                              'group ring-border bg-card relative flex min-h-[76px] cursor-pointer items-start gap-3 overflow-hidden rounded-lg p-3.5 text-left hover:ring',
                              isStaged && 'border-primary/45 bg-primary/5 ring-primary/15 ring-1',
                            )}
                          >
                            <span
                              className={cn(
                                'border-border/60 bg-background text-foreground/80 flex size-9 shrink-0 items-center justify-center rounded-md border transition-colors',
                                isStaged && 'border-primary/20 bg-primary/10 text-primary',
                              )}
                              style={{
                                backgroundColor: chalkColors(`${p.label?.trim()}`).background,
                                color: chalkColors(`${p.label?.trim()}`).foreground,
                                borderColor: chalkColors(`${p.label?.trim()}`).border,
                              }}
                            >
                              {isStaged ? (
                                <Check className="size-4" />
                              ) : (
                                <PromptIcon className="size-4" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-foreground text-sm leading-5 font-medium tracking-tight">
                                {p.label}
                              </div>
                              <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
                                {isStaged
                                  ? 'Saved. Opens in your composer after onboarding.'
                                  : (STARTER_PROMPT_DISPLAY_DESCRIPTIONS[p.id] ?? p.description)}
                              </p>
                            </div>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {!isInformational && currentStep.primaryCta && (
                  <Button
                    size="lg"
                    onClick={currentStep.primaryAction}
                    variant={currentStep.showStarterPrompts ? 'outline' : 'default'}
                    className="w-fit gap-1.5 active:scale-[0.98]"
                  >
                    {/* {isFounder ? <CalendarDays /> : null} */}
                    {currentStep.done && !isFounder && !currentStep.showStarterPrompts
                      ? 'Open it'
                      : currentStep.primaryCta}
                  </Button>
                )}
              </div>
            ) : null}
          </ModalBody>

          <ModalFooter className="border-border/60 bg-muted/25 flex-row items-center justify-between gap-2 border-t px-6 py-3.5 sm:justify-between md:px-6">
            <div className="flex items-center gap-1.5" aria-label="Onboarding progress">
              {steps.map((step, index) => (
                <button
                  key={step.id}
                  type="button"
                  aria-label={`Go to step ${index + 1}: ${step.title}`}
                  className={cn(
                    'focus-visible:ring-ring hit-area-2 focus-visible:ring-offset-background h-2 cursor-pointer rounded-full transition-[width,background-color,opacity] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                    activeDotIndex === index
                      ? 'bg-foreground w-6'
                      : 'bg-foreground/20 hover:bg-foreground/35 w-2',
                  )}
                  onClick={() => goToStep(index)}
                />
              ))}
            </div>
            <Button
              size="sm"
              className="min-w-20 active:scale-[0.98]"
              onClick={() => {
                if (isFinalScreen) {
                  onboarding.complete();
                  return;
                }
                advance();
              }}
            >
              {isFinalScreen || isLastStep ? 'Explore' : 'Next'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {showFounderStep && (
        <DemoQualifierModal
          open={calOpen}
          onOpenChange={setCalOpen}
          calLink={CAL_LINK}
          calNamespace={CAL_NAMESPACE}
          source="onboarding-wizard"
          title="Book a call with Marko"
          description="A couple of quick details so Marko can tailor the call."
          defaultName={defaultName}
          defaultEmail={defaultEmail}
          onBookingSuccessful={() => setFounderBooked(true)}
        />
      )}
    </>
  );
}
