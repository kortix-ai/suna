'use client';

/**
 * Routing as one rules table. Every row reads the same sentence across its
 * columns — "If this fails → Try in order → Only on" — so the project
 * default and each per-model exception are the same shape and easy to tell
 * apart. The default row comes first and owns the mode menu ("⋯"); the
 * exceptions follow under a counted band. Images and model defaults are not
 * "if this fails" rules, so they sit below the table.
 */

import {
  ArrowRightIcon,
  CaretDownIcon,
  DotsThreeIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

import { useTranslations } from '../../../../i18n';
import { Button } from '../../../../primitives/button';
import { CountBadge } from '../../../../primitives/count-badge';
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
} from '../../../../primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../../../primitives/dropdown-menu';
import Hint from '../../../../primitives/hint';
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

/** The four table columns: model, chain, condition, row action. */
const COLUMNS =
  'grid items-start gap-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_9rem_2rem] sm:gap-4';

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(COLUMNS, 'relative border-b px-4 py-3', className)}>{children}</div>;
}

/** A cell whose content lines up with the 32px controls in the row. */
function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-8 min-w-0 items-center', className)}>{children}</div>;
}

function ChainArrow() {
  return <ArrowRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />;
}

function MutedText({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

/** The "Try in order" cell: chips joined by arrows and one multi-select picker. */
function ChainCell({
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
    <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
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
      {disabled ? null : (
        <ModelPicker
          multiple
          models={selectableModels}
          selected={chain.models}
          exclude={primary ? [primary] : []}
          onToggle={toggle}
          trigger={<AddModelButton label={chain.models.length ? t('add') : t('addBackups')} />}
        />
      )}
      {chain.models.length === 0 ? <MutedText>{t('noBackups')}</MutedText> : null}
    </div>
  );
}

function ModeMenu({
  value,
  disabled,
  onChange,
}: {
  value: FallbackMode;
  disabled: boolean;
  onChange: (mode: FallbackMode) => void;
}) {
  const t = useTranslations('gatewayRouting');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('modeLabel')}
          className="text-muted-foreground hover:text-foreground"
        >
          <DotsThreeIcon className="size-4" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(mode) => onChange(mode as FallbackMode)}
        >
          <DropdownMenuRadioItem value="custom">{t('modeCustom')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="inherit">{t('modeInherit')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="disabled">{t('modeDisabled')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  inheritedFallbackOn,
  effectiveVisionModel,
  generationControls,
  controlsDisabled,
  writable,
}: RoutingLayoutProps) {
  const t = useTranslations('gatewayRouting');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const inheritedBackups = inheritedRoute.slice(1);
  const conditionLabel = (value: GatewayFallbackChain['fallbackOn']) =>
    value === 'any-error'
      ? tI18nComplete.raw('text6e2097e246af')
      : tI18nComplete.raw('text91721aa63069');
  const autoImagesLabel = effectiveVisionModel
    ? t('autoModel', { model: modelLabel(models, effectiveVisionModel) })
    : t('sameModels');

  return (
    <div className="space-y-8">
      <div className="overflow-hidden rounded-lg border">
        <div
          className={cn(
            COLUMNS,
            'bg-card text-muted-foreground hidden border-b px-4 py-2.5 text-xs font-medium sm:grid',
          )}
        >
          <span>{t('ifThisFails')}</span>
          <span>{t('tryInOrder')}</span>
          <span>{t('onlyOnHeader')}</span>
          <span />
        </div>

        {/* The project default: every request that has no exception. */}
        <Row>
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <ModelChip wire={primaryModel} models={models} />
            <span className="text-muted-foreground text-xs">{t('projectDefault')}</span>
          </div>
          {fallbackMode === 'custom' && draft.defaultFallback ? (
            <ChainCell
              primary={primaryModel}
              chain={draft.defaultFallback}
              models={models}
              selectableModels={selectableModels}
              availability={availability}
              disabled={controlsDisabled}
              onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
            />
          ) : fallbackMode === 'inherit' ? (
            <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
              <MutedText>{t('kortixPicks')}</MutedText>
              {inheritedBackups.map((wire, index) => (
                <span key={wire} className="inline-flex items-center gap-2">
                  {index > 0 ? <ChainArrow /> : null}
                  <ModelChip wire={wire} models={models} />
                </span>
              ))}
              {controlsDisabled ? null : (
                <AddModelButton
                  label={t('useMyOwn')}
                  onClick={() => changeFallbackMode('custom')}
                />
              )}
            </div>
          ) : (
            <Cell>
              <MutedText>{t('stopNote')}</MutedText>
            </Cell>
          )}
          <Cell>
            {fallbackMode === 'custom' && draft.defaultFallback?.models.length ? (
              <ConditionSelect
                value={draft.defaultFallback.fallbackOn}
                disabled={controlsDisabled}
                onChange={(fallbackOn) =>
                  setDraft({
                    ...draft,
                    defaultFallback: { ...draft.defaultFallback!, fallbackOn },
                  })
                }
              />
            ) : fallbackMode === 'inherit' ? (
              <MutedText>{conditionLabel(inheritedFallbackOn)}</MutedText>
            ) : (
              <span className="text-muted-foreground hidden text-sm sm:inline">—</span>
            )}
          </Cell>
          <Cell className="absolute top-3 right-3 justify-end sm:static">
            {writable ? (
              <ModeMenu
                value={fallbackMode}
                disabled={controlsDisabled}
                onChange={changeFallbackMode}
              />
            ) : null}
          </Cell>
        </Row>

        <div className="bg-card text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs font-medium">
          {t('exceptions')}
          {draft.rules.length > 0 ? <CountBadge count={draft.rules.length} /> : null}
        </div>

        {draft.rules.map((rule, index) => {
          const chain = { models: rule.fallbackModels, fallbackOn: rule.fallbackOn };
          return (
            <Row key={rule.model}>
              <Cell>
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
              </Cell>
              <ChainCell
                primary={rule.model}
                chain={chain}
                models={models}
                selectableModels={selectableModels}
                availability={availability}
                disabled={controlsDisabled}
                onChange={(next) =>
                  setRule(index, {
                    ...rule,
                    fallbackModels: next.models,
                    fallbackOn: next.fallbackOn,
                  })
                }
              />
              <Cell className={rule.fallbackModels.length ? undefined : 'hidden sm:flex'}>
                {rule.fallbackModels.length ? (
                  <ConditionSelect
                    value={rule.fallbackOn}
                    disabled={controlsDisabled}
                    onChange={(fallbackOn) => setRule(index, { ...rule, fallbackOn })}
                  />
                ) : (
                  <span className="text-muted-foreground hidden text-sm sm:inline">—</span>
                )}
              </Cell>
              <Cell className="absolute top-3 right-3 justify-end sm:static">
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
              </Cell>
            </Row>
          );
        })}

        <div className="px-2 py-1.5">
          {writable ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={controlsDisabled || !addRule}
              onClick={() => addRule?.()}
            >
              <PlusIcon className="size-3.5" /> {t('addException')}
            </Button>
          ) : draft.rules.length === 0 ? (
            <div className="px-2 py-1.5">
              <MutedText>{t('noExceptions')}</MutedText>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
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
      </div>

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
