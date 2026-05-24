'use client';

/**
 * Project setup checklist — surfaces the steps that make a project "ready",
 * driven entirely by {@link useProjectSetup}. Two surfaces share one body:
 *
 *   • <ProjectSetupChecklist>  — the card on the project index empty state.
 *   • <ProjectSetupNavItem> / <ProjectSetupRailItem> — the compact sidebar
 *     widget (expanded row + collapsed icon) that opens the same checklist
 *     in a popover.
 *
 * All three hide themselves once every essential step is done, so a fully
 * configured project carries no nagging chrome.
 */

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { SectionCard } from '@/components/ui/section-card';
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
import {
  useProjectSetup,
  type ProjectSetupState,
  type ProjectSetupStep,
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

/** Leading status glyph for a step row: a check when done, the step icon otherwise. */
function StatusCircle({ step }: { step: ProjectSetupStep }) {
  const Icon = step.icon;
  return (
    <span
      className={cn(
        'flex size-6 items-center justify-center rounded-full',
        step.done
          ? 'bg-primary/10 text-primary'
          : 'border border-border text-muted-foreground/70',
      )}
    >
      {step.done ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
    </span>
  );
}

/** The shared list of step rows. */
function SetupStepList({
  steps,
  onStep,
}: {
  steps: ProjectSetupStep[];
  onStep: (step: ProjectSetupStep) => void;
}) {
  return (
    <List>
      {steps.map((step) => (
        <ListRow
          key={step.id}
          className={step.done ? 'opacity-60' : undefined}
          onClick={step.done ? undefined : () => onStep(step)}
          leading={<StatusCircle step={step} />}
          title={step.title}
          badges={
            step.optional ? (
              <Badge size="sm" variant="outline">
                Optional
              </Badge>
            ) : null
          }
          subtitle={<span className="text-xs text-muted-foreground">{step.description}</span>}
          trailing={
            step.done ? null : (
              <Button
                size="sm"
                variant="ghost"
                className="text-primary hover:bg-primary/10 hover:text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  onStep(step);
                }}
              >
                {step.cta}
                <ArrowRight />
              </Button>
            )
          }
        />
      ))}
    </List>
  );
}

/** Routes a step click: the "session" step is handled by the caller. */
function useStepHandler(projectId: string, onStartSession?: () => void) {
  const router = useRouter();
  return useCallback(
    (step: ProjectSetupStep) => {
      if (step.id === 'session') {
        if (onStartSession) onStartSession();
        else router.push(`/projects/${projectId}`);
        return;
      }
      if (step.href) router.push(step.href);
    },
    [router, projectId, onStartSession],
  );
}

// ---------------------------------------------------------------------------
// Card variant — project index empty state
// ---------------------------------------------------------------------------

/** Remembers a per-project dismissal of the index card in localStorage. */
function useDismissed(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(key) === '1') setDismissed(true);
    } catch {
      /* private mode / SSR */
    }
  }, [key]);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  }, [key]);
  return [dismissed, dismiss];
}

export function ProjectSetupChecklist({
  projectId,
  onStartSession,
  className,
}: {
  projectId: string;
  onStartSession?: () => void;
  className?: string;
}) {
  const setup = useProjectSetup(projectId);
  const onStep = useStepHandler(projectId, onStartSession);
  const [dismissed, dismiss] = useDismissed(`kortix:setup-card-dismissed:${projectId}`);

  if (setup.isLoading || setup.isComplete || dismissed) return null;

  return (
    <SectionCard
      className={cn('w-full max-w-md shadow-sm', className)}
      title="Finish setting up your project"
      description={`${setup.requiredDone} of ${setup.requiredTotal} essential steps complete`}
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss setup checklist"
          onClick={dismiss}
        >
          <X />
        </Button>
      }
      flush
    >
      <div className="px-6 py-3">
        <Progress value={setup.percent} className="h-1.5" />
      </div>
      <div className="border-t border-border/60">
        <SetupStepList steps={setup.steps} onStep={onStep} />
      </div>
    </SectionCard>
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
  return (
    <div className="w-full overflow-hidden">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">Project setup</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {setup.requiredDone}/{setup.requiredTotal}
          </span>
        </div>
        <Progress value={setup.percent} className="mt-2.5 h-1.5" />
      </div>
      <div className="max-h-[60vh] overflow-y-auto border-t border-border/60">
        <SetupStepList steps={setup.steps} onStep={onStep} />
      </div>
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
        <PopoverContent side="right" align="end" sideOffset={12} className="w-80 p-0">
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
      <PopoverContent side="right" align="start" sideOffset={12} className="w-80 p-0">
        <SetupPopoverContent setup={setup} onStep={onStep} />
      </PopoverContent>
    </Popover>
  );
}
