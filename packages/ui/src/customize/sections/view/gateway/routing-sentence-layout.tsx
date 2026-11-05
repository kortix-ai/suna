'use client';

/**
 * Routing as plain sentences (Paper "03 · Plain sentences").
 *
 * Every rule reads as one English sentence with its controls inline:
 * "If GPT-5.5 fails, try my backups", "Try Sonnet 4.6 then Gemini 3.1 Pro",
 * "But if Opus 4.7 fails, try …", "Send images to …". There are no section
 * titles and no description lines; the sentence is the label. Help that used
 * to be a paragraph sits behind a `HelpMark`.
 */

import { ArrowLeftIcon, CaretDownIcon, PlusIcon as Plus, XIcon } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

import { useTranslations } from '../../../../i18n';
import { Button } from '../../../../primitives/button';
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
} from '../../../../primitives/disclosure';
import Hint from '../../../../primitives/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../primitives/select';
import { cn } from '../../../../internal/lib/utils';
import type { GatewayFallbackChain } from '@kortix/sdk';
import { modelKeyToWire } from '@kortix/sdk/react';

import {
  AvailabilityBadge,
  ConditionSelect,
  type FallbackMode,
  HelpMark,
  MAX_FALLBACKS,
  modelLabel,
  moveFallback,
  RoutingModelSelector,
  type RoutingLayoutProps,
  type RoutingModel,
} from './routing-parts';

/** One sentence: words and inline controls wrap together on one baseline. */
function Sentence({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-2 text-sm',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A fallback chain as inline chips: "Sonnet 4.6 then Gemini 3.1 Pro +".
 * Each chip is the model picker itself, so changing a step is one click.
 */
function ChainChips({
  primary,
  chain,
  models,
  availability,
  disabled,
  onChange,
}: {
  primary: string | null;
  chain: GatewayFallbackChain;
  models: RoutingModel[];
  availability: Record<string, boolean>;
  disabled: boolean;
  onChange: (chain: GatewayFallbackChain) => void;
}) {
  const t = useTranslations('routingLayouts');
  const taken = new Set([primary ?? '', ...chain.models]);
  const canAdd =
    chain.models.length < MAX_FALLBACKS &&
    models.some((model) => !taken.has(modelKeyToWire(model)));

  return (
    <>
      {chain.models.map((model, index) => (
        <span key={model} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span>{t('then')}</span> : null}
          <span className="inline-flex min-w-0 items-center">
            <RoutingModelSelector
              value={model}
              models={models}
              triggerVariant="secondary"
              exclude={[primary ?? '', ...chain.models.filter((_, other) => other !== index)]}
              disabled={disabled}
              onChange={(next) => {
                if (!next) return;
                const updated = [...chain.models];
                updated[index] = next;
                onChange({ ...chain, models: updated });
              }}
            />
            {disabled || index === 0 ? null : (
              <Hint label={t('moveEarlier', { model: modelLabel(models, model) })}>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('moveEarlier', { model: modelLabel(models, model) })}
                  onClick={() =>
                    onChange({ ...chain, models: moveFallback(chain.models, index, -1) })
                  }
                >
                  <ArrowLeftIcon className="size-3" />
                </Button>
              </Hint>
            )}
            {disabled ? null : (
              <Hint label={t('removeBackup', { model: modelLabel(models, model) })}>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('removeBackup', {
                    model: modelLabel(models, model),
                  })}
                  onClick={() =>
                    onChange({
                      ...chain,
                      models: chain.models.filter((_, other) => other !== index),
                    })
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              </Hint>
            )}
          </span>
          <AvailabilityBadge available={availability[model]} />
        </span>
      ))}
      {disabled || !canAdd ? null : (
        <RoutingModelSelector
          value={null}
          models={models}
          exclude={[...taken]}
          unsetLabel={chain.models.length ? t('addAnother') : t('addBackup')}
          onChange={(next) => next && onChange({ ...chain, models: [...chain.models, next] })}
        />
      )}
      {chain.models.length === 0 && (disabled || !canAdd) ? (
        <span className="text-muted-foreground">{t('emptyChain')}</span>
      ) : null}
    </>
  );
}

export function RoutingSentenceLayout({
  draft,
  setDraft,
  setRule,
  removeRule,
  addRule,
  fallbackMode,
  changeFallbackMode,
  models,
  availability,
  primaryModel,
  inheritedRoute,
  effectiveVisionModel,
  generationControls,
  controlsDisabled,
  writable,
}: RoutingLayoutProps) {
  const t = useTranslations('routingLayouts');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* The baseline rule. */}
      <section className="space-y-3">
        <div className="flex items-start gap-2">
          <Sentence>
            {t.rich('ifFails', {
              model: () => <span className="font-medium">{modelLabel(models, primaryModel)}</span>,
              mode: () => (
                <Select
                  value={fallbackMode}
                  disabled={controlsDisabled}
                  onValueChange={(mode) => changeFallbackMode(mode as FallbackMode)}
                >
                  <SelectTrigger size="sm" className="w-auto" aria-label={t('modeLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">{t('sentenceModeCustom')}</SelectItem>
                    <SelectItem value="inherit">{t('sentenceModeInherit')}</SelectItem>
                    <SelectItem value="disabled">{t('sentenceModeDisabled')}</SelectItem>
                  </SelectContent>
                </Select>
              ),
            })}
            <HelpMark label={t('backupsHelp')} />
          </Sentence>
        </div>

        {fallbackMode === 'custom' && draft.defaultFallback ? (
          <>
            <Sentence>
              {t.rich('tryChain', {
                chain: () => (
                  <ChainChips
                    primary={primaryModel}
                    chain={draft.defaultFallback!}
                    models={models}
                    availability={availability}
                    disabled={controlsDisabled}
                    onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
                  />
                ),
              })}
            </Sentence>
            <Sentence muted>
              {t.rich('onlyOn', {
                condition: () => (
                  <ConditionSelect
                    className="w-auto"
                    value={draft.defaultFallback!.fallbackOn}
                    disabled={controlsDisabled}
                    onChange={(fallbackOn) =>
                      setDraft({
                        ...draft,
                        defaultFallback: {
                          ...draft.defaultFallback!,
                          fallbackOn,
                        },
                      })
                    }
                  />
                ),
              })}
            </Sentence>
          </>
        ) : fallbackMode === 'inherit' && inheritedRoute.length > 1 ? (
          <Sentence muted>
            {t.rich('kortixTries', {
              route: () => (
                <span className="text-foreground">
                  {inheritedRoute
                    .slice(1)
                    .map((wire) => modelLabel(models, wire))
                    .join(` ${t('then')} `)}
                </span>
              ),
            })}
          </Sentence>
        ) : (
          <Sentence muted>{tI18nComplete.raw('texta3df3f9e4422')}</Sentence>
        )}
      </section>

      {/* Exceptions and images: one sentence per rule. */}
      <section className="border-t">
        {draft.rules.map((rule, index) => (
          <div key={rule.model} className="flex items-start gap-2 border-b py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Sentence>
                {t.rich('ruleSentence', {
                  model: () => (
                    <span className="inline-flex items-center gap-1.5">
                      <RoutingModelSelector
                        value={rule.model}
                        models={models}
                        triggerVariant="secondary"
                        exclude={usedRuleModels.filter((_, other) => other !== index)}
                        disabled={controlsDisabled}
                        onChange={(model) => model && setRule(index, { ...rule, model })}
                      />
                      <AvailabilityBadge available={availability[rule.model]} />
                    </span>
                  ),
                  chain: () => (
                    <ChainChips
                      primary={rule.model}
                      chain={{
                        models: rule.fallbackModels,
                        fallbackOn: rule.fallbackOn,
                      }}
                      models={models}
                      availability={availability}
                      disabled={controlsDisabled}
                      onChange={(chain) =>
                        setRule(index, {
                          ...rule,
                          fallbackModels: chain.models,
                          fallbackOn: chain.fallbackOn,
                        })
                      }
                    />
                  ),
                })}
              </Sentence>
              <Sentence muted>
                {t.rich('onlyOn', {
                  condition: () => (
                    <ConditionSelect
                      className="w-auto"
                      value={rule.fallbackOn}
                      disabled={controlsDisabled}
                      onChange={(fallbackOn) => setRule(index, { ...rule, fallbackOn })}
                    />
                  ),
                })}
              </Sentence>
            </div>
            {writable ? (
              <Hint label={t('removeRule')}>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('removeRule')}
                  disabled={controlsDisabled}
                  onClick={() => removeRule(index)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </Hint>
            ) : null}
          </div>
        ))}

        <div className="flex items-start gap-2 border-b py-3">
          <Sentence>
            {t.rich('imagesSentence', {
              model: () => (
                <span className="inline-flex items-center gap-1.5">
                  <RoutingModelSelector
                    value={draft.visionModel}
                    models={models}
                    triggerVariant="secondary"
                    disabled={controlsDisabled}
                    unsetLabel={
                      effectiveVisionModel
                        ? t('autoModel', { model: modelLabel(models, effectiveVisionModel) })
                        : t('sameModels')
                    }
                    onChange={(visionModel) => setDraft({ ...draft, visionModel })}
                  />
                  <AvailabilityBadge
                    available={draft.visionModel ? availability[draft.visionModel] : undefined}
                  />
                </span>
              ),
            })}
            <HelpMark label={t('imagesHelp')} />
          </Sentence>
        </div>

        {writable ? (
          <div className="flex items-center gap-1.5 pt-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2.5"
              disabled={controlsDisabled || !addRule}
              onClick={() => addRule?.()}
            >
              <Plus className="size-3.5" /> {t('addRule')}
            </Button>
            <HelpMark label={t('exceptionsHelp')} />
          </div>
        ) : null}
      </section>

      <Disclosure open={defaultsOpen} onOpenChange={setDefaultsOpen}>
        <DisclosureTrigger>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium transition-colors"
          >
            <CaretDownIcon
              className={cn('size-3.5 shrink-0 transition-transform', defaultsOpen && 'rotate-180')}
            />
            {t('modelDefaults')}
          </button>
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="pt-3">{generationControls}</div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}
