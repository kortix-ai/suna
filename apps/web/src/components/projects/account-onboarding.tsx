'use client';

/**
 * Account onboarding guide — the new-account "get started" card, driven by
 * {@link useAccountOnboarding}. Renders on the projects empty state (and, when
 * `dismissible`, above the grid while the account is still getting set up).
 * Hides itself once every essential step is done.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Check, Lock, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import { Progress } from '@/components/ui/progress';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';
import {
  useAccountOnboarding,
  type AccountOnboardingStep,
} from '@/hooks/projects/use-account-onboarding';

/** Leading status glyph: a check when done, a lock when not yet reachable. */
function StatusCircle({ step }: { step: AccountOnboardingStep }) {
  const Icon = step.locked ? Lock : step.icon;
  return (
    <span
      className={cn(
        'flex size-6 items-center justify-center rounded-full',
        step.done
          ? 'bg-primary/10 text-primary'
          : 'border border-border text-muted-foreground/70',
        step.locked && 'text-muted-foreground/40',
      )}
    >
      {step.done ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
    </span>
  );
}

/** Remembers a per-account dismissal in localStorage. */
function useDismissed(key: string | null): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!key) return;
    try {
      if (localStorage.getItem(key) === '1') setDismissed(true);
    } catch {
      /* private mode / SSR */
    }
  }, [key]);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      if (key) localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  }, [key]);
  return [dismissed, dismiss];
}

export function AccountOnboardingGuide({
  accountId,
  onCreateProject,
  dismissible = false,
  className,
}: {
  accountId: string | null;
  /** Opens the create-project modal owned by the page. */
  onCreateProject: () => void;
  dismissible?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const setup = useAccountOnboarding(accountId);
  const [dismissed, dismiss] = useDismissed(
    dismissible && accountId ? `kortix:account-onboarding-dismissed:${accountId}` : null,
  );

  const onStep = useCallback(
    (step: AccountOnboardingStep) => {
      if (step.locked || step.done) return;
      if (step.id === 'project') return onCreateProject();
      if (step.id === 'session' && setup.primaryProjectId)
        return router.push(`/projects/${setup.primaryProjectId}`);
      if (step.id === 'team' && accountId)
        return router.push(`/accounts/${accountId}?tab=members`);
    },
    [accountId, onCreateProject, router, setup.primaryProjectId],
  );

  if (setup.isLoading || setup.isComplete) return null;
  if (dismissible && dismissed) return null;

  return (
    <SectionCard
      className={cn('w-full max-w-xl shadow-sm', className)}
      title="Get started with Kortix"
      description={`${setup.requiredDone} of ${setup.requiredTotal} steps done`}
      action={
        dismissible ? (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
            <X />
          </Button>
        ) : undefined
      }
      flush
    >
      <div className="px-6 py-3">
        <Progress value={setup.percent} className="h-1.5" />
      </div>
      <div className="border-t border-border/60">
        <List>
          {setup.steps.map((step) => (
            <ListRow
              key={step.id}
              className={cn(step.done && 'opacity-60', step.locked && 'opacity-50')}
              onClick={step.done || step.locked ? undefined : () => onStep(step)}
              leading={<StatusCircle step={step} />}
              title={step.title}
              badges={
                step.optional ? (
                  <Badge size="sm" variant="outline">
                    Optional
                  </Badge>
                ) : null
              }
              subtitle={
                <span className="text-xs text-muted-foreground">{step.description}</span>
              }
              trailing={
                step.done ? null : (
                  <div className="flex items-center gap-0.5">
                    <Button
                      asChild
                      size="icon-sm"
                      variant="ghost"
                      className="text-muted-foreground/70 hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <a
                        href={step.learnHref}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Learn more"
                      >
                        <BookOpen className="size-3.5" />
                      </a>
                    </Button>
                    {!step.locked && (
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
                    )}
                  </div>
                )
              }
            />
          ))}
        </List>
      </div>
    </SectionCard>
  );
}
