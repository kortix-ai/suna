'use client';

import { CheckCircleSolid } from '@mynaui/icons-react';
import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useProjectSetup, type ProjectSetupStep } from '@/hooks/projects/use-project-setup';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import Link from 'next/link';

function SetupRing({ value, className }: { value: number; className?: string }) {
  const r = 7;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.max(0, Math.min(100, value)) / 100) * circ;
  return (
    <svg viewBox="0 0 18 18" className={cn('size-4 -rotate-90', className)} fill="none">
      <circle cx="9" cy="9" r={r} strokeWidth="2" className="stroke-kortix-base/15" />
      <circle
        cx="9"
        cy="9"
        r={r}
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-kortix-blue transition-[stroke-dashoffset] duration-500"
        strokeDasharray={circ}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

function useStepHandler(projectId: string, onStartSession?: () => void) {
  const router = useRouter();
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  return useCallback(
    (step: ProjectSetupStep) => {
      if (step.id === 'session') {
        if (onStartSession) onStartSession();
        else router.push(`/projects/${projectId}`);
        return;
      }
      if (step.section) openCustomize(step.section);
    },
    [router, projectId, onStartSession, openCustomize],
  );
}

function SetupPopoverBody({
  setup,
  onStep,
}: {
  setup: ReturnType<typeof useProjectSetup>;
  onStep: (step: ProjectSetupStep) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const essentials = setup.steps.filter((s) => !s.optional);
  const optionals = setup.steps.filter((s) => s.optional);
  const nextStep = essentials.find((s) => !s.done) ?? null;
  const nextId = nextStep?.id ?? null;
  const remaining = setup.requiredTotal - setup.requiredDone;
  const headline =
    remaining === 0
      ? 'All set'
      : remaining === setup.requiredTotal
        ? "Let's get your project running"
        : remaining === 1
          ? 'One step to go'
          : `${remaining} steps to go`;

  const renderSteps = (steps: ProjectSetupStep[], activeNextId: string | null) =>
    steps.map((step) => {
      const Icon = step.icon;
      const isNext = step.id === activeNextId;

      return (
        <Button
          key={step.id}
          variant="ghost"
          size="lg"
          disabled={step.done}
          onClick={() => {
            if (!step.done) onStep(step);
          }}
          className={cn(
            'flex h-auto w-full min-w-0 shrink flex-row items-start justify-start px-2.5 py-2 whitespace-normal',
            step.done
              ? 'text-muted-foreground cursor-default'
              : 'text-foreground hover:bg-kortix-base/4 cursor-pointer',
          )}
          aria-current={isNext && !step.done ? 'step' : undefined}
        >
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              step.done
                ? 'bg-kortix-green/12 text-kortix-green'
                : isNext
                  ? 'bg-kortix-blue/12 text-kortix-blue'
                  : 'bg-kortix-base/8 text-muted-foreground',
            )}
          >
            {step.done ? <CheckCircleSolid className="size-5" /> : <Icon className="size-5" />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start justify-start space-y-0">
            <span
              className={cn(
                'truncate text-sm font-medium tracking-tight',
                step.done ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {step.title}
            </span>
            <p className="text-muted-foreground/70 mt-0.5 w-full min-w-0 truncate text-xs">
              {step.description}
            </p>
          </div>
        </Button>
      );
    });

  return (
    <div className="w-full overflow-hidden">
      <div className="space-y-3 px-3 pt-3 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-foreground truncate text-sm font-semibold tracking-tight">
              {headline}
            </h3>
            {nextStep && (
              <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                Next: {nextStep.title.toLowerCase()}
              </p>
            )}
          </div>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {setup.requiredDone}/{setup.requiredTotal}
          </span>
        </div>
        <Progress
          value={setup.percent}
          className="bg-kortix-base/10 **:data-[slot=progress-indicator]:bg-kortix-blue h-1"
        />
      </div>

      <div className="border-border max-h-[56vh] overflow-y-auto border-t p-2">
        <div className="flex flex-col">{renderSteps(essentials, nextId)}</div>
        {optionals.length > 0 && (
          <div className="border-border mt-2 border-t">
            <div className="text-muted-foreground/70 px-1.5 pt-3 pb-1 text-xs font-medium">
              Recommended
            </div>
            <div className="flex flex-col">{renderSteps(optionals, null)}</div>
          </div>
        )}
      </div>

      <div className="border-border border-t">
        <Button
          asChild
          variant="ghost"
          size="lg"
          className="text-muted-foreground hover:bg-kortix-base/4 hover:text-foreground w-full justify-start overflow-hidden rounded-none"
        >
          <Link href="/docs/quickstart" target="_blank" rel="noreferrer">
            <BookOpen className="size-3" />
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarFooterProjectOnboardingSetupJsx957fad2d',
            )}
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function OnboardingSetupNavItem({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const setup = useProjectSetup(projectId);
  const onStep = useStepHandler(projectId);

  if (setup.isLoading || setup.isComplete) return null;

  return (
    <SidebarMenuItem>
      <Popover>
        <PopoverTrigger asChild>
          <SidebarMenuButton className="text-sm! font-medium [&_svg]:size-4!">
            <SetupRing value={setup.percent} />
            <span>
              {tI18nHardcoded.raw(
                'autoFeaturesCoWorkerProjectSidebarFooterProjectOnboardingSetupJsx814d0f37',
              )}
            </span>
            <span className="ml-auto pr-1 text-xs tabular-nums">
              {setup.requiredDone}/{setup.requiredTotal}
            </span>
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={12}
          className="w-[340px] overflow-hidden p-0"
        >
          <SetupPopoverBody setup={setup} onStep={onStep} />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

export function ProjectSetupRailItem({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const setup = useProjectSetup(projectId);
  const onStep = useStepHandler(projectId);

  if (setup.isLoading || setup.isComplete) return null;

  return (
    <Popover>
      <Hint label={`Set up project · ${setup.requiredDone}/${setup.requiredTotal}`}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            type="button"
            aria-label={tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectSidebarFooterProjectOnboardingSetupJsx66eaf244',
            )}
            className="flex items-center justify-center"
          >
            <SetupRing value={setup.percent} className="size-5" />
          </SidebarMenuButton>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        className="w-[340px] overflow-hidden rounded-xl p-0"
      >
        <SetupPopoverBody setup={setup} onStep={onStep} />
      </PopoverContent>
    </Popover>
  );
}
