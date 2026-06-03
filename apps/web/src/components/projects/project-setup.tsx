'use client';

/**
 * Project setup checklist — surfaces the steps that make a project "ready",
 * driven entirely by {@link useProjectSetup}. Two sidebar surfaces share one
 * body:
 *
 *   • <ProjectSetupNavItem> / <ProjectSetupRailItem> — the compact sidebar
 *     widget (expanded row + collapsed icon) that opens the same checklist
 *     in a popover.
 *
 * All three hide themselves once every essential step is done, so a fully
 * configured project carries no nagging chrome.
 */

import * as React from 'react';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Check, Sparkles } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import {
  useProjectSetup,
  type ProjectSetupState,
  type ProjectSetupStep,
  type ProjectSetupStepId,
} from '@/hooks/projects/use-project-setup';

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** Thin SVG completion ring — the sidebar's at-a-glance progress glyph. */
function SetupRing({ value, className }: { value: number; className?: string }) {
  const r = 7;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.max(0, Math.min(100, value)) / 100) * circ;
  return (
    <svg viewBox="0 0 18 18" className={cn('size-4 -rotate-90', className)} fill="none">
      <circle cx="9" cy="9" r={r} strokeWidth="2" className="stroke-primary/20" />
      <circle
        cx="9"
        cy="9"
        r={r}
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-500"
        strokeDasharray={circ}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

/** Step row — three visual states: done, next-up (emphasized), waiting. */
function StepRow({
  step,
  isNext,
  onClick,
}: {
  step: ProjectSetupStep;
  isNext: boolean;
  onClick: () => void;
}) {
  const Icon = step.icon;
  const isDone = step.done;

  return (
    <button
      type="button"
      disabled={isDone}
      onClick={isDone ? undefined : onClick}
      className={cn(
        'group relative flex w-full items-center gap-3 px-4 py-3 text-left',
        'transition-colors duration-150',
        isDone
          ? 'cursor-default'
          : 'cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50',
        'focus-visible:outline-none',
      )}
    >
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors',
          isDone
            ? 'border-primary/20 bg-primary/10 text-primary'
            : isNext
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-border bg-background text-muted-foreground/80',
        )}
      >
        {isDone ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-sm font-medium tracking-tight',
              isDone ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'text-foreground',
            )}
          >
            {step.title}
          </span>
        </div>
        <p
          className={cn(
            'mt-0.5 line-clamp-1 text-xs',
            isDone ? 'text-muted-foreground/60' : 'text-muted-foreground',
          )}
        >
          {step.description}
        </p>
      </div>

      {!isDone && (
        <span
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 text-xs font-medium transition-colors',
            isNext ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground',
          )}
        >
          {step.cta}
          <ArrowRight className="size-3" />
        </span>
      )}
    </button>
  );
}

function StepSection({
  label,
  steps,
  nextId,
  onStep,
}: {
  label?: string;
  steps: ProjectSetupStep[];
  nextId: ProjectSetupStepId | null;
  onStep: (step: ProjectSetupStep) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <div>
      {label && (
        <div className="px-4 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          {label}
        </div>
      )}
      <div className="flex flex-col">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            isNext={step.id === nextId}
            onClick={() => onStep(step)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Routes a step click. Most steps open the Customize overlay (in place, no
 * navigation) at the section that completes them; the "session" step starts a
 * session instead.
 */
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

// ---------------------------------------------------------------------------
// Card variant — project index empty state
// ---------------------------------------------------------------------------

/** Shared header for the popover + card surfaces. */
function SetupHeader({
  remaining,
  total,
  percent,
}: {
  remaining: number;
  total: number;
  percent: number;
}) {
  const headline =
    remaining === 0
      ? 'All set'
      : remaining === total
        ? "Let's get your project running"
        : remaining === 1
          ? 'One step to go'
          : `${remaining} steps to go`;

  return (
    <div className="px-5 pt-5 pb-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {headline}
          </h3>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {total - remaining}/{total}
        </span>
      </div>
      <Progress value={percent} className="mt-3 h-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar variants — popover-backed
// ---------------------------------------------------------------------------

function SetupPopoverContent({
  setup,
  onStep,
}: {
  setup: ProjectSetupState;
  onStep: (step: ProjectSetupStep) => void;
}) {
  const essentials = setup.steps.filter((s) => !s.optional);
  const optionals = setup.steps.filter((s) => s.optional);
  const nextId = essentials.find((s) => !s.done)?.id ?? null;
  const remaining = setup.requiredTotal - setup.requiredDone;

  return (
    <div className="w-full overflow-hidden">
      <SetupHeader
        remaining={remaining}
        total={setup.requiredTotal}
        percent={setup.percent}
      />
      <div className="max-h-[60vh] overflow-y-auto border-t border-border/60">
        <StepSection steps={essentials} nextId={nextId} onStep={onStep} />
        {optionals.length > 0 && (
          <div className="border-t border-border/60">
            <StepSection label="Optional" steps={optionals} nextId={null} onStep={onStep} />
          </div>
        )}
      </div>
      <a
        href="/docs/quickstart"
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-1.5 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground/80 transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <BookOpen className="size-3" />
        Read the quickstart guide
      </a>
    </div>
  );
}

/** Expanded sidebar row — renders an <li>; place inside a <SidebarMenu>. */
export function ProjectSetupNavItem({ projectId }: { projectId: string }) {
  const setup = useProjectSetup(projectId);
  const onStep = useStepHandler(projectId);

  if (setup.isLoading || setup.isComplete) return null;

  return (
    <SidebarMenuItem>
      <Popover>
        <PopoverTrigger asChild>
          <SidebarMenuButton className="!text-sm font-normal [&_svg]:!size-4">
            <SetupRing value={setup.percent} />
            <span>Set up project</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {setup.requiredDone}/{setup.requiredTotal}
            </span>
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent side="right" align="end" sideOffset={12} className="w-[360px] p-0 overflow-hidden rounded-2xl">
          <SetupPopoverContent setup={setup} onStep={onStep} />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

/** Collapsed icon-rail button — mirrors the rail's other icon buttons. */
export function ProjectSetupRailItem({ projectId }: { projectId: string }) {
  const setup = useProjectSetup(projectId);
  const onStep = useStepHandler(projectId);

  if (setup.isLoading || setup.isComplete) return null;

  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Set up project"
              className="flex w-full items-center justify-center rounded-lg py-2 text-sidebar-foreground transition-colors duration-150 ease-out hover:bg-sidebar-accent"
            >
              <SetupRing value={setup.percent} />
            </button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="right" sideOffset={12} className="text-xs">
          Set up project · {setup.requiredDone}/{setup.requiredTotal}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="start" sideOffset={12} className="w-[360px] p-0 overflow-hidden rounded-2xl">
        <SetupPopoverContent setup={setup} onStep={onStep} />
      </PopoverContent>
    </Popover>
  );
}
