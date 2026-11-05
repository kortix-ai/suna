'use client';

/**
 * Routing as plain sentences.
 *
 * Three groups, each answered by one sentence: what happens when a model
 * fails (All requests), where requests with an image go (Images), and the
 * per-model exceptions. Groups are told apart by a quiet label and space,
 * not by divider lines. A backup chain is a row of provider-logo chips;
 * one "Add backups" picker builds the whole chain in pick order.
 */

import { ArrowRightIcon, CaretDownIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
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

import {
  AddModelButton,
  ConditionSelect,
  type FallbackMode,
  MAX_FALLBACKS,
  ModelChip,
  ModelPicker,
  ModelPickerButton,
  modelLabel,
  type RoutingLayoutProps,
  type RoutingModel,
} from './routing-parts';

/** One sentence: words and inline controls wrap together on one line. */
function Sentence({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-2 text-sm',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {children}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-muted-foreground text-xs font-medium">{label}</h4>
      {children}
    </section>
  );
}

function ChainArrow() {
  return <ArrowRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />;
}

/**
 * An ordered backup chain: chips joined by arrows, then one picker that adds
 * or removes several models in a single visit, then the error condition.
 */
function BackupChain({
  primary,
  chain,
  models,
  selectableModels,
  availability,
  disabled,
  onChange,
}: {
  primary: string | null;
  chain: GatewayFallbackChain;
  models: RoutingModel[];
  selectableModels: RoutingModel[];
  availability: Record<string, boolean>;
  disabled: boolean;
  onChange: (chain: GatewayFallbackChain) => void;
}) {
  const t = useTranslations('gatewayRouting');
  const toggle = (wire: string) => {
    if (chain.models.includes(wire)) {
      onChange({ ...chain, models: chain.models.filter((model) => model !== wire) });
    } else if (chain.models.length < MAX_FALLBACKS) {
      onChange({ ...chain, models: [...chain.models, wire] });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {chain.models.map((wire, index) => (
          <span key={wire} className="inline-flex min-w-0 items-center gap-2">
            {index > 0 ? <ChainArrow /> : null}
            <ModelChip
              wire={wire}
              models={models}
              unavailable={availability[wire] === false}
              onRemove={disabled ? undefined : () => toggle(wire)}
            />
          </span>
        ))}
        {disabled ? (
          chain.models.length === 0 ? (
            <span className="text-muted-foreground text-sm">{t('noBackups')}</span>
          ) : null
        ) : (
          <ModelPicker
            multiple
            models={selectableModels}
            selected={chain.models}
            exclude={primary ? [primary] : []}
            onToggle={toggle}
            trigger={<AddModelButton label={chain.models.length ? t('add') : t('addBackups')} />}
          />
        )}
      </div>
      {chain.models.length > 0 ? (
        <Sentence muted>
          {t.rich('onlyOn', {
            condition: () => (
              <ConditionSelect
                value={chain.fallbackOn}
                disabled={disabled}
                onChange={(fallbackOn) => onChange({ ...chain, fallbackOn })}
              />
            ),
          })}
        </Sentence>
      ) : null}
    </div>
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
  selectableModels,
  availability,
  primaryModel,
  inheritedRoute,
  effectiveVisionModel,
  generationControls,
  controlsDisabled,
  writable,
}: RoutingLayoutProps) {
  const t = useTranslations('gatewayRouting');
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const inheritedBackups = inheritedRoute.slice(1);
  const autoImagesLabel = effectiveVisionModel
    ? t('autoModel', { model: modelLabel(models, effectiveVisionModel) })
    : t('sameModels');

  return (
    <div className="space-y-10">
      <Group label={t('allRequests')}>
        <Sentence>
          {t.rich('ifFails', {
            model: () => <ModelChip wire={primaryModel} models={models} />,
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
                  <SelectItem value="custom">{t('modeCustom')}</SelectItem>
                  <SelectItem value="inherit">{t('modeInherit')}</SelectItem>
                  <SelectItem value="disabled">{t('modeDisabled')}</SelectItem>
                </SelectContent>
              </Select>
            ),
          })}
        </Sentence>

        {fallbackMode === 'custom' && draft.defaultFallback ? (
          <BackupChain
            primary={primaryModel}
            chain={draft.defaultFallback}
            models={models}
            selectableModels={selectableModels}
            availability={availability}
            disabled={controlsDisabled}
            onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
          />
        ) : fallbackMode === 'inherit' && inheritedBackups.length > 0 ? (
          <Sentence muted>
            {t('kortixTries')}
            {inheritedBackups.map((wire, index) => (
              <span key={wire} className="inline-flex items-center gap-2">
                {index > 0 ? <ChainArrow /> : null}
                <ModelChip wire={wire} models={models} />
              </span>
            ))}
          </Sentence>
        ) : (
          <Sentence muted>{t('stopNote')}</Sentence>
        )}
      </Group>

      <Group label={t('images')}>
        <Sentence>
          {t.rich('sendImages', {
            model: () => (
              <ModelPicker
                models={selectableModels}
                selected={draft.visionModel ? [draft.visionModel] : []}
                disabled={controlsDisabled}
                onToggle={(visionModel) => setDraft({ ...draft, visionModel })}
                leading={{
                  label: autoImagesLabel,
                  active: draft.visionModel === null,
                  onSelect: () => setDraft({ ...draft, visionModel: null }),
                }}
                trigger={
                  <ModelPickerButton
                    wire={draft.visionModel}
                    models={models}
                    disabled={controlsDisabled}
                    unavailable={
                      draft.visionModel ? availability[draft.visionModel] === false : false
                    }
                    placeholder={autoImagesLabel}
                  />
                }
              />
            ),
          })}
        </Sentence>
      </Group>

      <Group label={t('exceptions')}>
        {draft.rules.map((rule, index) => (
          <div key={rule.model} className="space-y-3">
            <Sentence>
              {t.rich('exceptionIf', {
                model: () => (
                  <ModelPicker
                    models={selectableModels}
                    selected={[rule.model]}
                    exclude={usedRuleModels.filter((_, other) => other !== index)}
                    disabled={controlsDisabled}
                    onToggle={(model) => setRule(index, { ...rule, model })}
                    trigger={
                      <ModelPickerButton
                        wire={rule.model}
                        models={models}
                        disabled={controlsDisabled}
                        unavailable={availability[rule.model] === false}
                        placeholder={t('chooseModel')}
                      />
                    }
                  />
                ),
              })}
              {writable ? (
                <Hint label={t('removeException')}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('removeException')}
                    className="text-muted-foreground hover:text-foreground"
                    disabled={controlsDisabled}
                    onClick={() => removeRule(index)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </Hint>
              ) : null}
            </Sentence>
            <BackupChain
              primary={rule.model}
              chain={{ models: rule.fallbackModels, fallbackOn: rule.fallbackOn }}
              models={models}
              selectableModels={selectableModels}
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
          </div>
        ))}
        {writable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2.5"
            disabled={controlsDisabled || !addRule}
            onClick={() => addRule?.()}
          >
            <PlusIcon className="size-3.5" /> {t('addException')}
          </Button>
        ) : draft.rules.length === 0 ? (
          <Sentence muted>{t('noExceptions')}</Sentence>
        ) : null}
      </Group>

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
