'use client';

import type { AdminConnector } from '@kortix/sdk';
import { ArrowUpRightIcon, CaretDownIcon, CheckCircleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

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
          ? `${input.displayName} opens in a new tab. Sign in with the account the whole project should share — every session uses it.`
          : 'Each member signs in with their own account, under Accounts.',
        done: connectDone,
      }
    : input.usesProjectAuthorization
      ? {
          title: tI18nComplete.raw('text71ec1c2e842f'),
          hint: tI18nComplete.raw('text7b6f2f96318f'),
          done: connectDone,
        }
      : {
          title: tI18nComplete.raw('text24fa20ced6cc'),
          // Connect for a non-managed member-scoped connector writes the
          // member's own credential (see `connectsHere`).
          hint: tI18nComplete.raw('text2c32b9b6322c'),
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
 * The Overview's "what now?" for a connector that is not ready yet — a
 * disclosure list (Jay's SS9 pick, 2026-09-26). Finished steps collapse to
 * one quiet line, the CURRENT step opens with its explanation and its
 * explanation and a docs link, and what comes after is muted and labelled
 * Automatic. Connect itself lives in the page header, on every tab.
 */
export function ConnectorSetupSteps({
  connector,
  displayName,
  usesProjectAuthorization,
  isManagedProvider,
  hasStrategyConnection,
  action,
  helpLink,
}: {
  connector: AdminConnector;
  displayName: string;
  usesProjectAuthorization: boolean;
  isManagedProvider: boolean;
  hasStrategyConnection: boolean;
  /** The current step's button (Connect / Sign in). Omitted for readers. */
  action?: ReactNode;
  /** "How it works" — the Kortix guide for this provider. */
  helpLink?: { label: string; href: string; external?: boolean };
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
  const currentIndex = steps.findIndex((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;
  // Every step done = nothing to finish. A card of three green checks is
  // noise (Jay, 2026-09-26); the connected Overview takes over.
  if (currentIndex === -1) return null;

  return (
    <section className="space-y-2" aria-labelledby="connector-setup-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="connector-setup-title" className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('text51eb40d78f0a')}
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {tI18nComplete('textca6c5e5f6000', { value0: doneCount, value1: steps.length })}
        </span>
      </div>
      <div className="bg-popover divide-y overflow-hidden rounded-md border">
        {steps.map((step, index) => {
          // Only the CURRENT step is a disclosure — it is the only one with
          // something to say and something to do. Done and upcoming steps are
          // plain rows; a chevron on them opened a line that restated the
          // title (Jay, 2026-09-26).
          if (index !== currentIndex) {
            return (
              <div key={step.title} className="flex items-center gap-2.5 px-4 py-2.5">
                <StepMark state={step.done ? 'done' : 'upcoming'} />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                  {step.title}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {step.done ? step.hint : tI18nComplete.raw('textd461a493a375')}
                </span>
              </div>
            );
          }
          return (
            // Keyed on the step so a newly current step mounts open.
            <Disclosure key={step.title} defaultOpen className="group/step">
              <DisclosureTrigger>
                <div className="hover:bg-hover focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset">
                  <StepMark state="current" />
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                    {step.title}
                  </span>
                  <CaretDownIcon className="text-muted-foreground duration-moderate size-3.5 shrink-0 transition-transform ease-out group-data-[state=open]/step:rotate-180 motion-reduce:transition-none" />
                </div>
              </DisclosureTrigger>
              <DisclosureContent>
                <div className="space-y-3 pr-4 pb-3.5 pl-10">
                  {step.hint ? (
                    <p className="text-muted-foreground text-xs text-pretty">{step.hint}</p>
                  ) : null}
                  {action || helpLink ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {action}
                      {helpLink ? (
                        <Button
                          asChild
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground gap-1"
                        >
                          <Link
                            href={helpLink.href}
                            {...(helpLink.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                          >
                            {tI18nComplete.raw('text9c870aa6e5e9')}
                            <ArrowUpRightIcon className="size-3.5 shrink-0" />
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </DisclosureContent>
            </Disclosure>
          );
        })}
      </div>
    </section>
  );
}

/** Solid check-circle when done, a ring for the current step, a hollow
 *  circle for what comes after — one fixed 16px slot, so every title starts
 *  on the same lane. */
function StepMark({ state }: { state: 'done' | 'current' | 'upcoming' }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      {state === 'done' ? (
        <CheckCircleIcon weight="fill" className="text-kortix-green size-4" />
      ) : state === 'current' ? (
        <span className="border-foreground size-3.5 rounded-full border-4" />
      ) : (
        <span className="border-border size-3.5 rounded-full border" />
      )}
    </span>
  );
}
