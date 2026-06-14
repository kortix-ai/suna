'use client';

/**
 * ProjectOnboardingWizard — the guided multi-step setup flow that auto-opens
 * for newly-created projects.
 *
 * Step list is wizard-specific (NOT derived from the sidebar's setup
 * checklist): we deliberately drop "connect a repo" (every project already
 * has one) and re-order around real first-day value — connect tools → invite
 * the team → try a request → save it as an agent → automate it. Step 1 is a
 * personal "want help from Marko?" offer (cal embed), gated by
 * useShowPersonalContact() — cloud build flag AND a paid plan, so self-hosters
 * and free accounts never see the founder's face.
 *
 * Navigation is local (`currentIndex`) — user explicitly clicks Back/Continue;
 * pre-done steps still get shown, with an "Already set up" pill instead of
 * a primary CTA. Footer dots track WIZARD progress (past vs current vs
 * future), not project state — earlier "random tick" bug came from mixing
 * the two. Auto-advance only fires when THIS step's id transitions from
 * undone→done (user just configured it in customize).
 *
 * Persistence is localStorage via {@link useProjectOnboarding}; server-side
 * column is the documented follow-up — swap the hook's body, the wizard
 * doesn't change.
 */

import { DemoQualifierDialog } from '@/components/contact/demo-qualifier-dialog';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectOnboarding } from '@/hooks/projects/use-project-onboarding';
import { useShowPersonalContact } from '@/hooks/use-show-personal-contact';
import type { CustomizeSection } from '@/lib/customize-sections';
import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectSessions,
} from '@/lib/projects-client';
import { STARTER_PROMPTS, type StarterPrompt } from '@/lib/starter-prompts';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useCustomizeStore } from '@/stores/customize-store';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  Layers,
  MessageSquare,
  Plug,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Public team demo event (cal.com/team/kortix/demo). Namespace stays unique to
// this surface so the embed's UI config doesn't collide with other instances.
const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-onboarding-wizard';

const Q = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

type WizardStepId = 'founder' | 'integrations' | 'team' | 'first-request' | 'agents';

type WizardStep = {
  id: WizardStepId;
  icon: LucideIcon;
  title: string;
  /** Either a single string or a richer renderable for steps that want
   *  more structured copy (e.g. the closing informational step). */
  description: React.ReactNode;
  /** True ONLY when the underlying project state genuinely satisfies the
   *  step. Drives the "Already set up" pill and the auto-advance effect.
   *  Wizard progress (footer dots) does NOT use this. */
  done: boolean;
  /** When set, the step body renders a starter-prompts grid (clickable
   *  cards that pre-fill the composer and close the wizard) and the
   *  primary button below acts as the "skip with no prompt" path. */
  showStarterPrompts?: boolean;
  /** Pure explainer — no primary CTA, no "Already set up" pill. Used for
   *  the closing step that introduces the customization layer. */
  informational?: boolean;
  primaryCta?: string;
  primaryAction?: () => void;
};

export function ProjectOnboardingWizard({ projectId }: { projectId: string }) {
  const showPersonalContact = useShowPersonalContact();
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

  // QA convenience: visiting any project page with `?onboarding-reset` (or
  // `?onboarding-reset=1`) clears the server-side `metadata.onboarding_
  // completed_at` flag and re-opens the wizard for that project. Read
  // directly off the URL (not useSearchParams) so we don't depend on
  // Next.js's Suspense bailout behaviour — pure client-side, fire-once.
  const resetFn = onboarding.reset;
  const resetHydrated = onboarding.hydrated;
  const resetFiredRef = useRef(false);
  useEffect(() => {
    if (!resetHydrated || resetFiredRef.current) return;
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('onboarding-reset')) return;
    resetFiredRef.current = true;
    // Rewind to step 1 — otherwise a wizard that was previously finished
    // re-opens past the last step and renders nothing visible.
    setCurrentIndex(0);
    Promise.resolve()
      .then(() => resetFn())
      .then(() => toast.success('Onboarding reset — wizard reopened'))
      .catch((err) =>
        toast.error(
          `Couldn't reset onboarding: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    url.searchParams.delete('onboarding-reset');
    window.history.replaceState(null, '', url.toString());
  }, [resetHydrated, resetFn]);

  // Reuse the same query keys the rest of the project uses so the cache is
  // shared (no extra round-trips when the user lands here from anywhere).
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

  // First paint waits for the queries that gate the done-state we render —
  // showing "pending" then snapping to "done" looks broken.
  const isLoading = detail.isLoading || connectors.isLoading || sessions.isLoading;

  // Tracks whether the user just booked a call via the qualifier. Setting
  // this to true flips the founder step's `done` from false → true, which
  // makes the existing auto-advance effect carry the wizard forward without
  // any special-case navigation logic.
  const [founderBooked, setFounderBooked] = useState(false);
  // Remembers which example prompt the user picked so we can show a "saved
  // for later" check on it. The actual prompt rides through to the composer
  // via the prefill store; this state is purely visual feedback inside the
  // wizard — the wizard does NOT close on pick anymore.
  const [stagedPromptId, setStagedPromptId] = useState<string | null>(null);

  const openSection = useCallback(
    (section: CustomizeSection) => openCustomize(section),
    [openCustomize],
  );

  const steps: WizardStep[] = useMemo(() => {
    const list: WizardStep[] = [];

    if (showPersonalContact) {
      list.push({
        id: 'founder',
        icon: Sparkles,
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
        icon: Users,
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
          'Plug in the apps your agent should be able to use — Slack, Gmail, Salesforce, Notion, anything. The more it can reach, the more it can do for you.',
        done: connectorCount > 0,
        primaryCta: 'Connect a tool',
        primaryAction: () => openSection('connectors'),
      },
      {
        id: 'first-request',
        icon: MessageSquare,
        title: 'See what you can ask',
        description:
          'Examples of what your Kortix can do right now. Tap one to pre-fill the composer for after onboarding — or just look. Your agent can do all of this and more.',
        done: sessionCount > 0,
        showStarterPrompts: true,
      },
      {
        id: 'agents',
        icon: Layers,
        title: 'Make it your Kortix',
        informational: true,
        done: false,
        description: (
          <div className="space-y-3">
            <p>
              You start with a stack of general knowledge work skills pre-configured &mdash;
              research, writing, analysis, the basics. That&rsquo;s enough to get going.
            </p>
            <p>
              To make it truly <span className="text-foreground">yours</span>, build out:
            </p>
            <ul className="space-y-1.5 pl-1">
              <li>
                <span className="text-foreground font-medium">Agents</span> &mdash; personas shaped
                around how your team actually works.
              </li>
              <li>
                <span className="text-foreground font-medium">Skills</span> &mdash; turn the
                workflows you do over and over into one-line shortcuts that reach into your
                integrations.
              </li>
              <li>
                <span className="text-foreground font-medium">Commands</span> &mdash; slash
                shortcuts for the things you fire constantly.
              </li>
              <li>
                <span className="text-foreground font-medium">Automations</span> &mdash; schedules
                and webhooks that run work for you, no prompt needed.
              </li>
            </ul>
            <p>
              All of it lives in your repo as code, version-controlled, and compounds week over
              week.
            </p>
          </div>
        ),
      },
    );

    return list;
  }, [
    showPersonalContact,
    connectors.data,
    access.data,
    sessions.data,
    founderBooked,
    openSection,
  ]);

  const totalSteps = steps.length;
  const currentStep: WizardStep | undefined = steps[currentIndex];
  const isFinalScreen = currentIndex >= totalSteps && totalSteps > 0;

  // Auto-advance only when THIS step (same id) transitioned from undone to
  // done — i.e. the user came back from configuring it in customize. Pure
  // navigation (Back/Continue) onto an already-done step must not advance.
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

  const goBack = useCallback(() => {
    setCurrentIndex((i) => Math.max(i - 1, 0));
  }, []);

  return (
    <>
      <AnimatePresence>
        {shouldRender && (
          <motion.div
            key="wizard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              'fixed inset-0 z-30 flex items-center justify-center px-4 py-8',
              // Backdrop stays heavy + blurred even when customize/cal opens on
              // top, so the blur layer is consistent across surfaces (no flash
              // of the project page behind a thinner overlay).
              'bg-background/80 backdrop-blur-md',
              (customizeOpen || calOpen) && 'pointer-events-none',
            )}
            aria-hidden={customizeOpen || calOpen}
          >
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{
                opacity: customizeOpen || calOpen ? 0 : 1,
                y: 0,
                scale: 1,
              }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="relative w-full max-w-xl"
              role="dialog"
              aria-modal="true"
              aria-label="Project onboarding"
            >
              <div className="border-border/60 bg-card overflow-hidden rounded-3xl border shadow-[0_2px_4px_rgba(0,0,0,0.04),0_32px_80px_-16px_rgba(0,0,0,0.32)]">
                <Header
                  index={currentIndex}
                  total={totalSteps}
                  isFinal={isFinalScreen}
                  onClose={onboarding.complete}
                />

                <AnimatePresence mode="wait">
                  <motion.div
                    key={isFinalScreen ? '__final' : (currentStep?.id ?? 'empty')}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    className="px-8 pt-2 pb-6"
                  >
                    {isFinalScreen ? (
                      <FinalScreen onFinish={onboarding.complete} />
                    ) : currentStep ? (
                      <StepCard
                        step={currentStep}
                        stagedPromptId={stagedPromptId}
                        onPrimary={currentStep.primaryAction ?? (() => {})}
                        onPickStarterPrompt={(p) => {
                          // Stash for after onboarding — composer will pick it
                          // up via composer-prefill-store. Do NOT close the
                          // wizard; the user keeps walking through steps.
                          setPrefill(projectId, p.prompt);
                          setStagedPromptId(p.id);
                        }}
                      />
                    ) : null}
                  </motion.div>
                </AnimatePresence>

                <Footer
                  steps={steps}
                  currentIndex={currentIndex}
                  isFinal={isFinalScreen}
                  onBack={goBack}
                  onAdvance={advance}
                  onFinish={onboarding.complete}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showPersonalContact && (
        // Same screening gate as every other booking surface: teams under 11
        // are captured as a lead and confirmed, not put onto Marko's calendar.
        <DemoQualifierDialog
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

function Header({
  index,
  total,
  isFinal,
  onClose,
}: {
  index: number;
  total: number;
  isFinal: boolean;
  onClose: () => void;
}) {
  const stepNumber = Math.min(index + 1, total);
  return (
    <div className="border-border/60 relative flex items-center justify-between gap-3 border-b px-6 py-4">
      <div className="flex items-center gap-2.5">
        <KortixLogo size={18} />
        <span className="text-foreground text-sm font-medium tracking-tight">Project setup</span>
        <span className="text-muted-foreground/70 text-xs tabular-nums">
          {isFinal ? 'Done' : `${stepNumber} of ${total}`}
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Skip onboarding"
        className="text-muted-foreground/70 hover:bg-muted hover:text-foreground grid size-7 cursor-pointer place-items-center rounded-full"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function StepCard({
  step,
  stagedPromptId,
  onPrimary,
  onPickStarterPrompt,
}: {
  step: WizardStep;
  stagedPromptId: string | null;
  onPrimary: () => void;
  onPickStarterPrompt: (p: StarterPrompt) => void;
}) {
  const Icon = step.icon;
  const isFounder = step.id === 'founder';
  const isInformational = !!step.informational;

  return (
    <div className="flex flex-col gap-6 pt-6">
      <div className="flex flex-col items-start gap-5">
        {isFounder ? (
          <div className="border-border/60 bg-muted relative size-16 shrink-0 overflow-hidden rounded-2xl border">
            <Image
              src="/marko.png"
              alt="Marko Kraemer"
              width={128}
              height={128}
              priority
              className="size-full object-cover"
            />
          </div>
        ) : (
          <span
            className={cn(
              'flex size-12 items-center justify-center rounded-2xl transition-colors',
              step.done && !isInformational
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-foreground/80',
            )}
          >
            {step.done && !isInformational ? (
              <Check className="size-5" />
            ) : (
              <Icon className="size-5" />
            )}
          </span>
        )}

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-foreground text-xl font-semibold tracking-tight sm:text-[22px]">
              {step.title}
            </h2>
            {step.done && !isFounder && !isInformational && (
              <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                Already set up
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-2 text-[15px] leading-relaxed">
            {step.description}
          </div>
        </div>
      </div>

      {step.id === 'integrations' && <BusinessAppLogos onPick={onPrimary} />}

      {step.showStarterPrompts && (
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTER_PROMPTS.map((p) => {
            const PIcon = p.icon;
            const isStaged = stagedPromptId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPickStarterPrompt(p)}
                className={cn(
                  'group bg-card/60 relative flex cursor-pointer items-start gap-3 rounded-2xl border p-3 text-left',
                  'transition-all duration-150',
                  'hover:border-foreground/25 hover:bg-card hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
                  'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                  isStaged ? 'border-primary/40 ring-primary/20 ring-1' : 'border-border/60',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                    isStaged
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-foreground/80 group-hover:text-foreground',
                  )}
                >
                  {isStaged ? <Check className="size-4" /> : <PIcon className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium tracking-tight">
                    {p.label}
                  </div>
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                    {isStaged ? 'Saved — opens in your composer after onboarding.' : p.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!isInformational && step.primaryCta && (
        <div className="flex items-center gap-3">
          <Button
            size="lg"
            onClick={onPrimary}
            variant={step.showStarterPrompts ? 'outline' : 'default'}
            className="gap-1.5"
          >
            {isFounder ? <CalendarDays /> : null}
            {step.done && !isFounder && !step.showStarterPrompts ? 'Open it' : step.primaryCta}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Business-app logos ──────────────────────────────────────────────────────
// Surfaced on the "Connect your tools" step. Uses Google's public favicon
// service (same pattern as the landing page) — no custom SVGs, no
// trademark-stripped icon library to dance around. Each tile click-throughs
// to the connectors customize section; the grid is a visual menu, not
// per-app entry points.

const faviconUrl = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

type BusinessApp = { id: string; name: string; domain: string };

const BUSINESS_APPS: BusinessApp[] = [
  { id: 'google', name: 'Google Workspace', domain: 'workspace.google.com' },
  { id: 'microsoft', name: 'Microsoft 365', domain: 'microsoft.com' },
  { id: 'salesforce', name: 'Salesforce', domain: 'salesforce.com' },
  { id: 'sap', name: 'SAP', domain: 'sap.com' },
  { id: 'slack', name: 'Slack', domain: 'slack.com' },
  { id: 'notion', name: 'Notion', domain: 'notion.so' },
  { id: 'hubspot', name: 'HubSpot', domain: 'hubspot.com' },
  { id: 'linear', name: 'Linear', domain: 'linear.app' },
];

function BusinessAppLogos({ onPick }: { onPick: () => void }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {BUSINESS_APPS.map((app) => (
        <button
          key={app.id}
          type="button"
          onClick={onPick}
          title={app.name}
          aria-label={`Connect ${app.name}`}
          className={cn(
            'group border-border/60 bg-card/60 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3',
            'transition-all duration-150',
            'hover:border-foreground/25 hover:bg-card hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]',
            'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={faviconUrl(app.domain)}
            alt={app.name}
            width={24}
            height={24}
            className="size-6 rounded-sm"
          />
          <span className="text-muted-foreground/80 group-hover:text-foreground truncate text-[10px]">
            {app.name}
          </span>
        </button>
      ))}
    </div>
  );
}

function FinalScreen({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="flex flex-col items-start gap-6 pt-6">
      <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-2xl">
        <Sparkles className="size-5" />
      </span>
      <div>
        <h2 className="text-foreground text-xl font-semibold tracking-tight sm:text-[22px]">
          You&rsquo;re all set
        </h2>
        <p className="text-muted-foreground mt-2 text-[15px] leading-relaxed">
          Your command center is ready. Describe a task in the composer and your agent gets to work.
        </p>
      </div>
      <Button size="lg" onClick={onFinish} className="gap-1.5">
        Start building
        <ArrowRight />
      </Button>
    </div>
  );
}

function Footer({
  steps,
  currentIndex,
  isFinal,
  onBack,
  onAdvance,
  onFinish,
}: {
  steps: WizardStep[];
  currentIndex: number;
  isFinal: boolean;
  onBack: () => void;
  onAdvance: () => void;
  onFinish: () => void;
}) {
  const canGoBack = currentIndex > 0 && !isFinal;
  const isLastStep = !isFinal && currentIndex === steps.length - 1;
  const currentStep = steps[currentIndex];

  return (
    <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-3 border-t px-6 py-3">
      <div className="flex items-center gap-1.5" aria-label="Wizard progress">
        {steps.map((s, i) => {
          // Dots reflect WIZARD progress only — past vs current vs future.
          // We deliberately ignore `s.done` here; mixing wizard nav with
          // project state caused the "random ticks" bug.
          const isActive = i === currentIndex && !isFinal;
          const isPast = i < currentIndex || isFinal;
          return (
            <span
              key={s.id}
              aria-label={`Step ${i + 1}: ${s.title}`}
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-[10px] font-medium tabular-nums transition-all',
                isPast
                  ? 'bg-primary/10 text-primary'
                  : isActive
                    ? 'border-primary/40 bg-primary/5 text-primary border'
                    : 'border-border bg-background text-muted-foreground/60 border',
              )}
            >
              {isPast ? <Check className="size-3" /> : i + 1}
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-1">
        {canGoBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ArrowLeft />
            Back
          </Button>
        )}
        {!isFinal &&
          (isLastStep ? (
            <Button size="sm" onClick={onFinish} className="gap-1">
              Finish
              <Check />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onAdvance} className="gap-1">
              {currentStep?.done ? 'Continue' : 'Skip this step'}
              <ChevronRight />
            </Button>
          ))}
      </div>
    </div>
  );
}
