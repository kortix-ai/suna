'use client';

/**
 * Step 2, survey question 1 — what the team will actually use Kortix for.
 *
 * This is the only answer that changes what the user sees later: it picks the
 * three starting points on the finish step. Domain and size are captured, not
 * acted on.
 */

import type { OnboardingUseCase } from '@kortix/sdk';
import {
  ChartLineUpIcon,
  CodeIcon,
  CurrencyDollarIcon,
  DotsThreeIcon,
  HeadsetIcon,
  MegaphoneIcon,
  UserPlusIcon,
  type Icon,
} from '@phosphor-icons/react';

import { RadioGroup } from '@/components/ui/radio-group';

import { USE_CASE_OPTIONS } from '../onboarding-profile';
import { SelectionRow, StepShell } from '../step-shell';

/**
 * One icon per use case — scanned left→right before the label is read.
 * Metaphor over ornament: headset = support, megaphone = marketing, etc.
 */
const USE_CASE_ICONS: Record<OnboardingUseCase, Icon> = {
  sales: ChartLineUpIcon,
  support: HeadsetIcon,
  marketing: MegaphoneIcon,
  engineering: CodeIcon,
  finance_ops: CurrencyDollarIcon,
  hr_recruiting: UserPlusIcon,
  other: DotsThreeIcon,
};

export function UseCaseStep({
  value,
  onSelect,
  onContinue,
  onSkip,
}: {
  value: OnboardingUseCase | null;
  onSelect: (v: OnboardingUseCase) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <StepShell
      title="What will you use Kortix for?"
      description="We use this to pick the right starting points for you. You can change it later."
      primaryLabel="Continue"
      primaryDisabled={!value}
      onPrimary={onContinue}
      skipLabel="Skip survey"
      onSkip={onSkip}
    >
      <RadioGroup
        value={value ?? ''}
        onValueChange={(nextValue) => onSelect(nextValue as OnboardingUseCase)}
        aria-label="Use case"
        className="gap-2"
      >
        {USE_CASE_OPTIONS.map((option) => {
          const Icon = USE_CASE_ICONS[option.value];
          return (
            <SelectionRow
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.description}
              leading={
                <Icon
                  className="text-muted-foreground size-5 shrink-0"
                  aria-hidden
                  weight={option.weight}
                />
              }
            />
          );
        })}
      </RadioGroup>
    </StepShell>
  );
}
