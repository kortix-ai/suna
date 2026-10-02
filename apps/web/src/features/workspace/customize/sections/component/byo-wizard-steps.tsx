'use client';

import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { m } from 'motion/react';
import type { ReactNode } from 'react';

export function ByoWizardSteps({
  steps,
  step,
  onStepChange,
  children,
}: {
  steps: readonly { step: 1 | 2 | 3; title: string }[];
  step: 1 | 2 | 3;
  onStepChange: (step: 1 | 2 | 3) => void;
  children: (step: 1 | 2 | 3) => ReactNode;
}) {
  return (
    <Stepper
      orientation="vertical"
      count={steps.length}
      value={step}
      onValueChange={(v) => {
        if (v === 1 || v === 2 || v === 3) onStepChange(v);
      }}
      className="flex w-full flex-col"
    >
      {steps.map(({ step: n, title }) => {
        const active = n === step;
        return (
          <div key={n} className="flex gap-3">
            {/* `disabled` belongs on StepperItem, not the trigger — the
                      trigger reads it from item context. Only completed steps
                      are re-visitable; jumping ahead would skip the
                      confirmation each step exists to collect. */}
            <StepperItem step={n} disabled={n > step} className="items-center">
              <StepperTrigger className="flex shrink-0">
                <StepperIndicator className="size-6 text-xs font-semibold tabular-nums">
                  {n < step ? <CheckIcon className="size-3" /> : n}
                </StepperIndicator>
              </StepperTrigger>
              <StepperSeparator className="m-0" />
            </StepperItem>

            <div className={cn('min-w-0 flex-1 pt-0.5', active ? 'pb-6' : 'pb-4')}>
              <StepperTitle
                className={cn(
                  'transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {title}
              </StepperTitle>

              {active ? (
                <m.div
                  key={`body-${n}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="mt-3 space-y-4"
                >
                  {children(n)}
                </m.div>
              ) : null}
            </div>
          </div>
        );
      })}
    </Stepper>
  );
}
