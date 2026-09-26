'use client';

/**
 * Step 3 — which models Kortix uses. The last step: its primary opens the
 * project.
 *
 * Selecting a row only selects. Continue performs the choice, and its label
 * names what it will do:
 * - Kortix models that are ready, or an own key that is connected: open the project.
 * - Kortix models without access: see plans.
 * - An own key with none connected: add a key. Once one is added the label
 *   becomes "Open workspace" (`planAction`).
 *
 * "Decide later" opens the project too. The composer asks for a model the
 * first time it needs one, so deferring is a real answer.
 */

import { KeyIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { RadioGroup } from '@/components/ui/radio-group';
import { Kortix } from '@/features/icon/icons/kortix';
import { flattenModels } from '@/features/session/session-chat-input';
import { useModelConnectionGate } from '@/features/session/use-model-connection-gate';
import { useTranslations } from '@/i18n/use-translations';
import { useRuntimeProviders } from '@kortix/sdk/react';

import { hasModelsFrom, planAction, type PlanChoice } from '../plan-action';
import { SelectionRow, StepShell } from '../step-shell';

/**
 * `projectId` is REQUIRED, never inferred. `useModelConnectionGate` falls back
 * to the `[id]` route segment, and this step also renders on `/new`, which has
 * none: an inferred project is `null` there, `modal` is `null`, and "Add a key"
 * opens nothing. Do not relax this to `?:`.
 */
export function PlanStep({ projectId, onContinue }: { projectId: string; onContinue: () => void }) {
  const t = useTranslations('projectOnboarding.plan');
  const { data: providers } = useRuntimeProviders();
  const models = flattenModels(providers);
  const { openConnectProvider, openUpgrade, modal, showUpgradeOption } = useModelConnectionGate(
    models,
    { projectId },
  );
  const access = hasModelsFrom(models);
  const offerKortix = showUpgradeOption || access.hasKortixModels;
  const [picked, setPicked] = useState<PlanChoice | null>(null);
  const choice: PlanChoice = picked ?? (offerKortix ? 'kortix' : 'byok');
  const action = planAction(choice, access);

  // Nothing opens until Continue.
  const handleContinue = () => {
    if (action === 'seePlans') openUpgrade();
    else if (action === 'addKey') openConnectProvider('providers');
    else onContinue();
  };

  return (
    <>
      {modal}
      <StepShell
        title={t('title')}
        description={t('description')}
        primaryLabel={
          action === 'seePlans' ? t('seePlans') : action === 'addKey' ? t('addKey') : t('open')
        }
        onPrimary={handleContinue}
        skipLabel={t('decideLater')}
        onSkip={onContinue}
      >
        <RadioGroup
          value={choice}
          onValueChange={(next) => setPicked(next as PlanChoice)}
          aria-label={t('modelAccess')}
          className="gap-2"
        >
          {offerKortix && (
            <SelectionRow
              value="kortix"
              label={t('useKortix')}
              badge={
                <Badge variant="outline" size="xs">
                  {t('recommended')}
                </Badge>
              }
              description={t('useKortixDescription')}
              leading={<Kortix className="size-5 shrink-0" />}
            />
          )}
          <SelectionRow
            value="byok"
            label={t('bringKey')}
            description={access.hasOwnKey ? t('keyConnected') : t('providerDescription')}
            leading={<KeyIcon className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
        </RadioGroup>
      </StepShell>
    </>
  );
}
