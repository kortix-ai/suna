'use client';

/**
 * Routing as a rule list and one editor (Paper "07 · Split: rules + editor").
 *
 * The default chain and every per-model exception are the same kind of thing
 * — "if this fails, try these" — so they sit in one list on the left. The
 * right pane edits the selected one. Images and model defaults are two more
 * entries at the bottom of the list. Labels only; help sits behind a
 * `HelpMark`.
 */

import {
  ImageIcon,
  PlusIcon as Plus,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';

import { useTranslations } from '../../../../i18n';
import { Button } from '../../../../primitives/button';
import { CountBadge } from '../../../../primitives/count-badge';
import Hint from '../../../../primitives/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../primitives/select';
import { cn } from '../../../../internal/lib/utils';

import {
  AvailabilityBadge,
  ChainRows,
  type FallbackMode,
  HelpMark,
  modelLabel,
  RoutingModelSelector,
  type RoutingLayoutProps,
} from './routing-parts';

type Selection = 'all' | 'images' | 'defaults' | `rule:${string}`;

function RailItem({
  active,
  icon,
  label,
  trailing,
  onSelect,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
        active ? 'bg-accent text-foreground font-medium' : 'text-foreground hover:bg-accent',
      )}
    >
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

function PaneTitle({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm font-medium">
      {children}
      {help ? <HelpMark label={help} /> : null}
    </div>
  );
}

export function RoutingSplitLayout({
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
  const [selected, setSelected] = useState<Selection>('all');

  const ruleIndex = selected.startsWith('rule:')
    ? draft.rules.findIndex((rule) => `rule:${rule.model}` === selected)
    : -1;
  // A removed or renamed rule falls back to the default chain.
  const current: Selection = selected.startsWith('rule:') && ruleIndex < 0 ? 'all' : selected;
  const usedRuleModels = draft.rules.map((rule) => rule.model);
  const backupCount =
    fallbackMode === 'custom'
      ? (draft.defaultFallback?.models.length ?? 0)
      : fallbackMode === 'inherit'
        ? Math.max(inheritedRoute.length - 1, 0)
        : 0;

  let pane: ReactNode;
  if (current === 'all') {
    pane = (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PaneTitle help={t('backupsHelp')}>{t('ifAnyFails')}</PaneTitle>
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
        </div>
        {fallbackMode === 'custom' && draft.defaultFallback ? (
          <ChainRows
            addLabel={t('addBackup')}
            conditionLabel={t('retryOn')}
            primary={primaryModel}
            chain={draft.defaultFallback}
            models={models}
            disabled={controlsDisabled}
            availability={availability}
            onChange={(defaultFallback) => setDraft({ ...draft, defaultFallback })}
          />
        ) : fallbackMode === 'inherit' && inheritedRoute.length > 1 ? (
          <ol className="flex flex-col gap-1">
            {inheritedRoute.slice(1).map((wire, index) => (
              <li key={wire} className="text-foreground flex items-center gap-2 text-sm">
                <span className="text-muted-foreground w-4 text-xs tabular-nums">{index + 1}</span>
                {modelLabel(models, wire)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">{tI18nComplete.raw('texta3df3f9e4422')}</p>
        )}
      </>
    );
  } else if (current === 'images') {
    pane = (
      <>
        <PaneTitle help={t('imagesHelp')}>{t('imagesTitle')}</PaneTitle>
        <div className="flex items-center gap-2">
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
        </div>
      </>
    );
  } else if (current === 'defaults') {
    pane = (
      <>
        <PaneTitle>{t('defaultsTitle', { model: modelLabel(models, primaryModel) })}</PaneTitle>
        {generationControls}
      </>
    );
  } else {
    const rule = draft.rules[ruleIndex]!;
    pane = (
      <>
        <div className="flex items-start justify-between gap-2">
          <PaneTitle help={t('exceptionsHelp')}>
            {t.rich('ifModelFails', {
              model: () => (
                <span className="inline-flex items-center gap-1.5">
                  <RoutingModelSelector
                    value={rule.model}
                    models={models}
                    triggerVariant="secondary"
                    exclude={usedRuleModels.filter((_, other) => other !== ruleIndex)}
                    disabled={controlsDisabled}
                    onChange={(model) => {
                      if (!model) return;
                      setRule(ruleIndex, { ...rule, model });
                      setSelected(`rule:${model}`);
                    }}
                  />
                  <AvailabilityBadge available={availability[rule.model]} />
                </span>
              ),
            })}
          </PaneTitle>
          {writable ? (
            <Hint label={t('removeRule')}>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('removeRule')}
                disabled={controlsDisabled}
                onClick={() => {
                  removeRule(ruleIndex);
                  setSelected('all');
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </Hint>
          ) : null}
        </div>
        <ChainRows
          addLabel={t('addBackup')}
          conditionLabel={t('retryOn')}
          primary={rule.model}
          chain={{ models: rule.fallbackModels, fallbackOn: rule.fallbackOn }}
          models={models}
          disabled={controlsDisabled}
          availability={availability}
          onChange={(chain) =>
            setRule(ruleIndex, {
              ...rule,
              fallbackModels: chain.models,
              fallbackOn: chain.fallbackOn,
            })
          }
        />
      </>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-md border sm:flex-row">
      <nav
        aria-label={t('rulesNav')}
        className="flex shrink-0 flex-col gap-0.5 border-b p-2 sm:w-56 sm:border-r sm:border-b-0"
      >
        <RailItem
          active={current === 'all'}
          icon={<SquaresFourIcon className="size-4" />}
          label={t('allModels')}
          trailing={backupCount ? <CountBadge count={backupCount} /> : null}
          onSelect={() => setSelected('all')}
        />
        <div className="text-muted-foreground flex items-center gap-1.5 px-2 pt-3 pb-1 text-xs">
          {t('exceptions')}
        </div>
        {draft.rules.map((rule) => (
          <RailItem
            key={rule.model}
            active={current === `rule:${rule.model}`}
            icon={
              availability[rule.model] === false ? (
                <span className="bg-kortix-orange size-1.5 rounded-full" />
              ) : (
                <span className="bg-muted-foreground/40 size-1.5 rounded-full" />
              )
            }
            label={modelLabel(models, rule.model)}
            trailing={
              rule.fallbackModels.length ? <CountBadge count={rule.fallbackModels.length} /> : null
            }
            onSelect={() => setSelected(`rule:${rule.model}`)}
          />
        ))}
        {writable ? (
          <button
            type="button"
            disabled={controlsDisabled || !addRule}
            onClick={() => {
              const added = addRule?.();
              if (added) setSelected(`rule:${added}`);
            }}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Plus className="size-3.5" />
            </span>
            {t('addRule')}
          </button>
        ) : null}
        <div className="sm:flex-1" />
        <div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
          <RailItem
            active={current === 'images'}
            icon={<ImageIcon className="size-4" />}
            label={t('images')}
            trailing={
              <span className="text-muted-foreground max-w-24 truncate text-xs">
                {draft.visionModel ? modelLabel(models, draft.visionModel) : t('auto')}
              </span>
            }
            onSelect={() => setSelected('images')}
          />
          <RailItem
            active={current === 'defaults'}
            icon={<SlidersHorizontalIcon className="size-4" />}
            label={t('modelDefaults')}
            onSelect={() => setSelected('defaults')}
          />
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">{pane}</div>
    </div>
  );
}
