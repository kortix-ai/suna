'use client';

/**
 * How to power the agent.
 *
 * The earlier version fired a modal the instant a row was clicked. That is the
 * defect: the user taps to *consider* an option and gets a whole separate flow
 * thrown at them, so they back out and lose the thread. Here, selecting a row
 * only selects. `Continue` performs whatever was chosen.
 *
 * "Decide later" exists so nobody is ever cornered. The chat composer already
 * gates on model connection at the moment it actually matters, which makes
 * deferring a legitimate answer rather than an escape hatch.
 */

import { ClockIcon as Clock, KeyIcon as Key } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { RadioGroup } from '@/components/ui/radio-group';
import { flattenModels } from '@/features/session/session-chat-input';
import { useModelConnectionGate } from '@/features/session/use-model-connection-gate';
import { useRuntimeProviders } from '@kortix/sdk/react';

import { Kortix } from '@/features/icon/icons/kortix';
import { SelectionRow, StepShell } from '../step-shell';

type PlanChoice = 'kortix' | 'byok' | 'later';

/**
 * `projectId` is passed explicitly, never inferred. `useModelConnectionGate`
 * falls back to the `[id]` route segment, and this step also renders on `/new`
 * (`app/(app)/new`), which has none — an inferred project is `null` there, so
 * `modal` is `null` and `openConnectProvider` opens nothing while
 * `handleContinue` never reaches `onContinue()`. This step passes no `onSkip`
 * to `StepShell`, so its primary button is the only control: an inferred id
 * strands the user on step 4 of 5.
 */
export function PlanStep({
  projectId,
  onContinue,
}: {
  /**
   * REQUIRED, deliberately — this is the guard on the defect above.
   *
   * `useModelConnectionGate` falls back to `useParams().id` when given no
   * explicit id, and `/new` has no `[id]` segment, so an omitted prop here
   * silently reproduces the dead-click bug in full. Optional, it was
   * unguardable: dropping `projectId={projectId}` at the single call site
   * passed the entire test suite AND `tsc`, because a missing optional prop is
   * legal and no test can see one that was never there. Required, the same
   * edit is a compile error. Do not relax this to `?:`.
   */
  projectId: string;
  onContinue: () => void;
}) {
  const t = useTranslations('projectOnboarding.plan');
  const { data: providers } = useRuntimeProviders();
  const { openConnectProvider, openUpgrade, modal, hasSelectableModels, showUpgradeOption } =
    useModelConnectionGate(flattenModels(providers), { projectId });
  const [choice, setChoice] = useState<PlanChoice | null>(null);

  // Nothing opens until Continue. This is the whole point of the step.
  const handleContinue = () => {
    if (choice === 'kortix') openUpgrade();
    else if (choice === 'byok') openConnectProvider('providers');
    else onContinue();
  };

  return (
    <>
      {modal}
      <StepShell
        title={t('title')}
        description={hasSelectableModels ? t('descriptionConnected') : t('descriptionDisconnected')}
        // The label names what the button will actually do, so the modal that
        // opens is never a surprise.
        primaryLabel={
          choice === 'kortix' ? t('seePlans') : choice === 'byok' ? t('addKey') : t('continue')
        }
        onPrimary={handleContinue}
      >
        {/* A connected model is context, not an answer. The options stay so the
            user can add a provider or move onto a plan. */}
        <RadioGroup
          value={choice ?? ''}
          onValueChange={(nextChoice) => setChoice(nextChoice as PlanChoice)}
          aria-label={t('modelAccess')}
          className="gap-2"
        >
          {showUpgradeOption && (
            <SelectionRow
              value="kortix"
              label={t('useKortix')}
              description={t('useKortixDescription')}
              leading={<Kortix className="size-5 shrink-0" />}
            />
          )}
          <SelectionRow
            value="byok"
            label={hasSelectableModels ? t('connectAnother') : t('bringKey')}
            description={t('providerDescription')}
            leading={<Key className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
          <SelectionRow
            value="later"
            label={hasSelectableModels ? t('keepCurrent') : t('decideLater')}
            description={
              hasSelectableModels ? t('keepCurrentDescription') : t('decideLaterDescription')
            }
            leading={<Clock className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
        </RadioGroup>
      </StepShell>
    </>
  );
}
