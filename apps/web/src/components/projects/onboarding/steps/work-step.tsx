'use client';

/**
 * Step 1 — what the person mostly works on.
 *
 * One pick from eight tiles. "Something else" opens a short field, so an
 * answer that fits no tile is still an answer. Continue saves the pick; the
 * first chat and memory can read it later from the project profile.
 */

import type { OnboardingUseCase } from '@kortix/sdk';
import {
  BuildingsIcon,
  CheckCircleIcon,
  CodeIcon,
  GearSixIcon,
  HeadsetIcon,
  LayoutIcon,
  MegaphoneIcon,
  PlusIcon,
  TrendUpIcon,
  type Icon,
} from '@phosphor-icons/react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, useRef } from 'react';

import { Input } from '@/components/ui/input';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { USE_CASE_NOTE_MAX, WORK_OPTIONS } from '../onboarding-profile';
import { StepShell } from '../step-shell';

const ICONS: Partial<Record<OnboardingUseCase, Icon>> = {
  founder: BuildingsIcon,
  engineering: CodeIcon,
  product_design: LayoutIcon,
  sales: TrendUpIcon,
  marketing: MegaphoneIcon,
  finance_ops: GearSixIcon,
  support: HeadsetIcon,
  other: PlusIcon,
};

export function WorkStep({
  value,
  note,
  onValueChange,
  onNoteChange,
  onContinue,
}: {
  value: OnboardingUseCase | null;
  note: string;
  onValueChange: (value: OnboardingUseCase) => void;
  onNoteChange: (note: string) => void;
  onContinue: () => void;
}) {
  const t = useTranslations('projectOnboarding.work');
  const noteId = useId();
  const noteRef = useRef<HTMLInputElement>(null);
  const other = value === 'other';

  return (
    <StepShell
      title={t('title')}
      description={t('description')}
      primaryLabel={t('continue')}
      primaryDisabled={value === null}
      onPrimary={onContinue}
    >
      <RadioGroupPrimitive.Root
        value={value ?? ''}
        onValueChange={(next) => {
          onValueChange(next as OnboardingUseCase);
          // The field appears under the grid; typing should not need a second click.
          if (next === 'other') requestAnimationFrame(() => noteRef.current?.focus());
        }}
        aria-label={t('ariaLabel')}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {WORK_OPTIONS.map((option) => {
          const Glyph = ICONS[option] ?? PlusIcon;
          return (
            <RadioGroupPrimitive.Item
              key={option}
              value={option}
              className={cn(
                'group border-border bg-popover text-foreground flex h-12 w-full cursor-pointer items-center gap-3 rounded-md border px-4 text-left text-sm',
                'transition-[background-color,border-color,scale] duration-(--duration-normal) active:scale-[0.99] motion-reduce:active:scale-100',
                'hover:border-primary/30 hover:bg-primary/[0.03]',
                'data-[state=checked]:border-primary/40 data-[state=checked]:bg-primary/[0.05] data-[state=checked]:font-medium',
                'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
              )}
            >
              <Glyph className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t(`options.${option}`)}</span>
              <CheckCircleIcon
                weight="fill"
                aria-hidden
                className="text-foreground size-4 shrink-0 opacity-0 transition-opacity duration-(--duration-fast) group-data-[state=checked]:opacity-100"
              />
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>

      {other && (
        <div className="mt-5 flex flex-col gap-2">
          <label htmlFor={noteId} className="text-foreground text-sm">
            {t('noteLabel')}
          </label>
          <Input
            ref={noteRef}
            id={noteId}
            value={note}
            maxLength={USE_CASE_NOTE_MAX}
            placeholder={t('notePlaceholder')}
            onChange={(event) => onNoteChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onContinue();
              }
            }}
          />
        </div>
      )}
    </StepShell>
  );
}
