'use client';

import type { AdminConnector } from '@kortix/sdk';
import { CheckIcon } from '@phosphor-icons/react';

import type { UiTranslator } from '@/i18n/translator';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';

interface SetupStep {
  title: string;
  hint: string;
  done: boolean;
}

/**
 * What the steps ARE, as pure derivation — exported for the unit test. Three
 * steps, always: added (a fact), connect (the one human step, worded for the
 * shape of the connector), sync (automatic, so its hint says so).
 */
export function connectorSetupSteps(
  input: {
    displayName: string;
    managed: boolean;
    requiresCredential: boolean;
    usesProjectAuthorization: boolean;
    credentialSet: boolean;
    hasStrategyConnection: boolean;
    toolCount: number;
    failing: boolean;
  },
  tI18nComplete: UiTranslator,
): SetupStep[] {
  const connectDone = input.managed
    ? input.hasStrategyConnection
    : input.requiresCredential
      ? input.usesProjectAuthorization
        ? input.credentialSet
        : input.hasStrategyConnection
      : true;
  const connect: SetupStep = input.managed
    ? {
        title: tI18nComplete('text2e300bb1c797', { value0: input.displayName }),
        hint: input.usesProjectAuthorization
          ? 'Use Connect above — one shared sign-in the whole project uses.'
          : 'Connect your own account under Accounts, below.',
        done: connectDone,
      }
    : input.usesProjectAuthorization
      ? {
          title: tI18nComplete.raw('text71ec1c2e842f'),
          hint: tI18nComplete.raw('textc4b8a965e9ef'),
          done: connectDone,
        }
      : {
          title: tI18nComplete.raw('text24fa20ced6cc'),
          hint: tI18nComplete.raw('text9bbde51bfbd3'),
          done: connectDone,
        };
  return [
    { title: tI18nComplete.raw('text0668b6bceb30'), hint: '', done: true },
    connect,
    {
      title: tI18nComplete.raw('textae5bd6d7ed0b'),
      hint: input.failing
        ? 'The last sync failed — see the reason above. It retries once the connection works.'
        : input.toolCount > 0
          ? `${input.toolCount} ${input.toolCount === 1 ? 'tool' : 'tools'} available.`
          : 'Runs by itself right after the connection works — nothing to do here.',
      done: input.toolCount > 0 && !input.failing,
    },
  ];
}

/**
 * The "what now?" answer for a connector that is not ready yet: three live
 * steps with the current one lit, each naming where its action lives (the
 * panel above, the Accounts tab below). Renders nothing once connected —
 * a finished checklist is clutter (Jay, 2026-09-14: "Needs setup, but no
 * clear way what the next step is").
 */
export function ConnectorSetupSteps({
  connector,
  displayName,
  usesProjectAuthorization,
  isManagedProvider,
  hasStrategyConnection,
}: {
  connector: AdminConnector;
  displayName: string;
  usesProjectAuthorization: boolean;
  isManagedProvider: boolean;
  hasStrategyConnection: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const steps = connectorSetupSteps(
    {
      displayName,
      managed: isManagedProvider,
      requiresCredential: Boolean(connector.authSecret),
      usesProjectAuthorization,
      credentialSet: connector.secretSet,
      hasStrategyConnection,
      toolCount: connector.actions.length,
      failing: connector.status === 'error',
    },
    tI18nComplete,
  );
  const active = steps.findIndex((step) => !step.done) + 1 || steps.length;

  return (
    /* One bordered card, same shape as the connection panel above it — the
       checklist reads as one object, not loose page prose (Jay, 2026-09-14). */
    <section
      className="bg-popover space-y-3 rounded-md border px-4 py-3"
      aria-labelledby="connector-setup-title"
    >
      <h2 id="connector-setup-title" className="text-foreground text-sm font-medium">
        {tI18nComplete.raw('text51eb40d78f0a')}
      </h2>
      <Stepper
        orientation="vertical"
        value={active}
        count={steps.length}
        className="flex w-full flex-col"
      >
        {steps.map((step, index) => (
          <div key={step.title} className="flex gap-3.5">
            <StepperItem step={index + 1} completed={step.done} className="items-center">
              <StepperTrigger asChild>
                <span className="flex shrink-0">
                  <StepperIndicator className="size-6 text-xs font-medium tabular-nums">
                    {step.done ? <CheckIcon className="size-3.5" /> : index + 1}
                  </StepperIndicator>
                </span>
              </StepperTrigger>
              <StepperSeparator className="bg-secondary m-0" />
            </StepperItem>
            <div
              className={
                index === steps.length - 1 ? 'min-w-0 flex-1 pt-0.5' : 'min-w-0 flex-1 pt-0.5 pb-5'
              }
            >
              <StepperTitle className="text-foreground text-sm font-medium">
                {step.title}
              </StepperTitle>
              {step.hint ? (
                <StepperDescription className="text-muted-foreground text-xs text-pretty">
                  {step.hint}
                </StepperDescription>
              ) : null}
            </div>
          </div>
        ))}
      </Stepper>
    </section>
  );
}
