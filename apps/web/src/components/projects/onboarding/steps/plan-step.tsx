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
import { useState } from 'react';

import { RadioGroup } from '@/components/ui/radio-group';
import { flattenModels } from '@/features/session/session-chat-input';
import { useModelConnectionGate } from '@/features/session/use-model-connection-gate';
import { useRuntimeProviders } from '@kortix/sdk/react';

import { Kortix } from '@/features/icon/icons/kortix';
import { SelectionRow, StepShell } from '../step-shell';

type PlanChoice = 'kortix' | 'byok' | 'later';

export function PlanStep({ onContinue }: { onContinue: () => void }) {
  const { data: providers } = useRuntimeProviders();
  const { openConnectProvider, openUpgrade, modal, hasSelectableModels, showUpgradeOption } =
    useModelConnectionGate(flattenModels(providers));
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
        title="How do you want to power your agent?"
        description={
          hasSelectableModels
            ? 'A model is already connected, so you’re good to go. Add another provider or upgrade if you want more.'
            : 'Your agent needs a model to think with. Nothing happens until you continue.'
        }
        // The label names what the button will actually do, so the modal that
        // opens is never a surprise.
        primaryLabel={
          choice === 'kortix' ? 'See plans' : choice === 'byok' ? 'Add a key' : 'Continue'
        }
        onPrimary={handleContinue}
      >
        {/* A connected model is context, not an answer. The options stay so the
            user can add a provider or move onto a plan. */}
        <RadioGroup
          value={choice ?? ''}
          onValueChange={(nextChoice) => setChoice(nextChoice as PlanChoice)}
          aria-label="Model access"
          className="gap-2"
        >
          {showUpgradeOption && (
            <SelectionRow
              value="kortix"
              label="Use Kortix models"
              description="Instant access, higher limits, nothing to configure"
              leading={<Kortix className="size-5 shrink-0" />}
            />
          )}
          <SelectionRow
            value="byok"
            label={hasSelectableModels ? 'Connect another provider' : 'Bring your own API key'}
            description="Anthropic, OpenAI, or any other provider"
            leading={<Key className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
          <SelectionRow
            value="later"
            label={hasSelectableModels ? 'Keep what I have' : 'Decide later'}
            description={
              hasSelectableModels
                ? 'Carry on with the model that’s already connected'
                : 'The composer will ask the first time you send a task'
            }
            leading={<Clock className="text-muted-foreground size-5 shrink-0" weight="duotone" />}
          />
        </RadioGroup>
      </StepShell>
    </>
  );
}
