'use client';

import { Badge } from '../../../primitives/badge';
import Hint from '../../../primitives/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../primitives/hover-card';
import { Switch } from '../../../primitives/switch';
import { Tag } from '../../../primitives/tag';
import { errorToast } from '../../../primitives/toast';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../internal/lib/utils';
import { isManagedModelId, MANAGED_ENDPOINT_PROVIDERS } from '@kortix/llm-catalog';
import {
  useModelAccess,
  useModelDefaults,
  useModelEnablement,
  useProjectModelPickerCatalog,
  wireToModelKey,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  FolderSimpleIcon as Folder,
  DotsThreeIcon as MoreHorizontal,
  StarIcon as Star,
} from '@phosphor-icons/react';
import { type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../primitives/dropdown-menu';

import { Copy } from '../../../icons/copy';
import { ModelCapabilityIcons } from './model-capability-icons';
import { formatPricePerMillion, formatTokenCount } from './utils';

import type { ModelGroup, ModelRow } from './model-rows';

export type ModelContext = {
  access: ReturnType<typeof useModelAccess>;
  enablement: ReturnType<typeof useModelEnablement>;
  defaults: ReturnType<typeof useModelDefaults>;
  pickerCatalog: ReturnType<typeof useProjectModelPickerCatalog>;
  canWrite: boolean;
  holdsDataClaim: (modelID: string) => boolean;
};

/** A row status pill as the Models board draws it: sentence case, Roobert,
 *  round. `Badge`'s default is the uppercase mono label used elsewhere. */
const STATUS_PILL = 'rounded-full font-sans text-xs tracking-normal normal-case';

export function ModelsTabRow({
  model, wireId, isRollingAlias, group, providerDisabled, access, enablement,
  defaults, pickerCatalog, canWrite, holdsDataClaim,
}: ModelRow & ModelContext & { group: ModelGroup; providerDisabled: boolean }) {
  const tAccess = useTranslations('modelAccess');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tList = useTranslations('modelsList');
  const isManaged =
    group.providerID === 'kortix' && isManagedModelId(model.modelID);
  const enabled = !!model.enabled;
  const modelDisabled = access.data?.disabledModels.includes(wireId) ?? false;
  const hiddenFromPicker =
    !!access.data && !enabled && !providerDisabled && !modelDisabled;
  // `auto` resolves to this one, so turning it off would break
  // every default request — the server refuses it with a 409.
  // Lock the switch and say why instead of letting the click
  // become a failed action.
  const isProjectDefault = wireId === enablement.defaultModel;
  // `useModelDefaults` builds every scope with `wireToModelKey`,
  // which parks the whole wire id in `modelID` under the `kortix`
  // provider — so this is the same comparison as the line above.
  const isAccountDefault = defaults.accountDefault?.modelID === wireId;
  const ctx = formatTokenCount(model.contextWindow);
  const pricingRoutes = isManaged
    ? pickerCatalog?.managedPricingRoutes?.[wireId]
    : undefined;
  // The row shows ONE price — the cheapest route's, as "from" —
  // and the hover card shows every route. The routes used to be
  // printed as full sentences under each managed model.
  const hasRoutes = !!pricingRoutes && pricingRoutes.length > 0;
  const priceIn = formatPricePerMillion(
    hasRoutes
      ? Math.min(...pricingRoutes.map((route) => route.input))
      : model.cost?.input,
  );
  const priceOut = formatPricePerMillion(
    hasRoutes
      ? Math.min(...pricingRoutes.map((route) => route.output))
      : model.cost?.output,
  );
  const turnedOff = modelDisabled || providerDisabled;
  const metaLine = hiddenFromPicker
    ? tList('hiddenLine')
    : modelDisabled
      ? tList('blockedLine')
      : [
          isManaged
            ? model.capabilities?.vision
              ? tAccess('textImage')
              : tAccess('textOnly')
            : null,
          ctx ? tList('context', { value: ctx }) : null,
          priceIn && priceOut
            ? tList(hasRoutes ? 'fromPrice' : 'price', {
                input: priceIn,
                output: priceOut,
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    // A plain row, NOT a <label>: it holds several controls and a
    // label binds to the FIRST labelable one, so "click the row
    // to toggle" never did what it looked like.
    <div
      key={wireId}
      data-model-id={wireId}
      className="border-border hover:bg-hover flex min-h-13 items-center gap-3 border-t px-4 py-2 transition-[background-color] duration-(--duration-normal) first-of-type:border-t-0"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'truncate text-sm font-medium',
              turnedOff ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {model.modelName}
          </span>
          {/* Both default scopes badge the model that holds them. */}
          {isProjectDefault && (
            <Hint label={tI18nComplete.raw('text68cde35131cf')} side="bottom">
              <Badge variant="info" size="sm" className={STATUS_PILL}>
                {tI18nComplete.raw('text5e06ae1125b5')}
              </Badge>
            </Hint>
          )}
          {isAccountDefault && (
            <Hint label={tI18nComplete.raw('textd197e66e9634')} side="bottom">
              <Badge variant="info" size="sm" className={STATUS_PILL}>
                {tI18nComplete.raw('text071c0f5e8495')}
              </Badge>
            </Hint>
          )}
          {hiddenFromPicker && (
            <Hint label={tAccess('hiddenHint')} side="bottom">
              <Badge variant="muted" size="sm" className={STATUS_PILL}>
                {tAccess('hidden')}
              </Badge>
            </Hint>
          )}
          {modelDisabled && !providerDisabled && (
            <Badge variant="destructive" size="sm" className={STATUS_PILL}>
              {tAccess('disabled')}
            </Badge>
          )}
          {/* Same display name as its pinned snapshots — say
              which row is the one that rolls forward. */}
          {isRollingAlias && (
            <Hint label={tI18nComplete.raw('text7482f09d1b13')} side="bottom">
              <Tag>{tI18nComplete.raw('textf096ba0a2aa6')}</Tag>
            </Hint>
          )}
        </div>
        {metaLine ? (
          hasRoutes && !hiddenFromPicker && !modelDisabled ? (
            <ModelPriceHoverCard
              modelName={model.modelName}
              routes={pricingRoutes}
              dataClaim={holdsDataClaim(model.modelID)}
            >
              {metaLine}
            </ModelPriceHoverCard>
          ) : (
            <p className="text-muted-foreground text-xs tabular-nums">{metaLine}</p>
          )
        ) : null}
      </div>
      <div className="flex w-18 shrink-0 justify-end">
        <ModelCapabilityIcons
          chips
          reasoning={model.capabilities?.reasoning}
          toolCall={model.capabilities?.toolcall}
          vision={model.capabilities?.vision}
        />
      </div>
      {/*
        Both default scopes and the wire id, in the row's own
        menu. Gated on `enabled`: a model the project does not
        OFFER cannot be anyone's default (the server refuses it).
        `DropdownMenuContent` resolves its z-index through
        `useDialogDepth`, so it stacks above the modal too.
      */}
      {canWrite && (enabled || hiddenFromPicker) ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={defaults.isUpdating}
              aria-label={tI18nComplete('text43d1a2b807aa', {
                value0: model.modelName,
              })}
              title={tI18nComplete.raw('textc3b312278ee5')}
              className="text-muted-foreground hover:text-foreground hover:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color] duration-(--duration-normal) disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-90">
            {hiddenFromPicker && (
              <DropdownMenuItem
                disabled={access.isUpdating}
                onSelect={() =>
                  void access
                    .setEnabled({ target: 'model', id: wireId, enabled: false })
                    .catch((error: unknown) =>
                      errorToast(
                        error instanceof Error
                          ? error.message
                          : tAccess('modelError'),
                      ),
                    )
                }
              >
                {tAccess('disableModel')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!enabled || isProjectDefault || defaults.isUpdating}
              onSelect={() =>
                void defaults.setProjectDefault(wireToModelKey(wireId))
              }
            >
              <Folder className="size-3.5" />
              {tI18nComplete.raw('text246d55bd2682')}
              {isProjectDefault && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!enabled || isAccountDefault || defaults.isUpdating}
              onSelect={() =>
                void defaults.setAccountDefault(wireToModelKey(wireId))
              }
            >
              <Star className="size-3.5" />
              {tI18nComplete.raw('textc74a21a56d79')}
              {isAccountDefault && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void navigator.clipboard?.writeText(wireId)}
            >
              <Copy className="size-3.5" />
              {tI18nComplete.raw('text16af2c8fb28f')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Keeps the switch lane aligned on rows with no menu.
        <span aria-hidden className="size-6 shrink-0" />
      )}
      <Switch
        checked={enabled}
        disabled={
          !canWrite ||
          access.isLoading ||
          access.isUpdating ||
          (isProjectDefault && enabled) ||
          providerDisabled
        }
        aria-label={
          isProjectDefault
            ? tI18nComplete('texta931b0c34b16', { value0: model.modelName })
            : `Enable ${model.modelName}`
        }
        title={
          isProjectDefault
            ? tI18nComplete.raw('textecb89227d17e')
            : hiddenFromPicker
              ? tAccess('hiddenShort')
              : undefined
        }
        onCheckedChange={(next) =>
          void access
            .setEnabled({ target: 'model', id: wireId, enabled: next })
            .catch((error: unknown) =>
              errorToast(
                error instanceof Error ? error.message : tAccess('modelError'),
              ),
            )
        }
        className="shrink-0"
      />
    </div>
  );
}

type ManagedPricingRoute = NonNullable<
  NonNullable<ReturnType<typeof useProjectModelPickerCatalog>>['managedPricingRoutes']
>[string][number];

/**
 * The row's price, underlined; hovering opens every serving route's price and
 * the data notes. The routes used to be printed as full sentences under each
 * managed model — four lines of numbers per row.
 */
export function ModelPriceHoverCard({
  modelName,
  routes,
  dataClaim,
  children,
}: {
  modelName: string;
  routes: readonly ManagedPricingRoute[];
  dataClaim: boolean;
  children: ReactNode;
}) {
  const tAccess = useTranslations('modelAccess');
  const tList = useTranslations('modelsList');
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="text-foreground decoration-muted-foreground block cursor-help text-left text-xs tabular-nums underline decoration-dotted underline-offset-3"
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-98 space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-foreground text-sm font-medium tabular-nums">
            {tList('perMillion', { model: modelName })}
          </p>
          {/* The estimate disclaimer, one hover away. */}
          <Hint label={tAccess('pricingEstimate')}>
            <span tabIndex={0} className="text-muted-foreground cursor-help text-xs">
              {tList('estimate')}
            </span>
          </Hint>
        </div>
        <div className="space-y-1.5 text-xs tabular-nums">
          <div className="text-muted-foreground flex gap-2">
            <span className="min-w-0 flex-1">{tList('route')}</span>
            <span className="w-13 shrink-0 text-right">{tList('input')}</span>
            <span className="w-13 shrink-0 text-right">{tList('cached')}</span>
            <span className="w-13 shrink-0 text-right">{tList('output')}</span>
          </div>
          {routes.map((price) => (
            <div key={price.route} className="text-foreground flex gap-2" data-pricing-route={price.route}>
              <span className="min-w-0 flex-1 truncate">
                {(MANAGED_ENDPOINT_PROVIDERS as Record<string, string>)[price.route] ??
                  price.route.split('/')[0]}
                {price.role === 'preferred' ? ` · ${tAccess('pricingPreferred')}` : ''}
              </span>
              <span className="w-13 shrink-0 text-right">{formatPricePerMillion(price.input)}</span>
              <span className="w-13 shrink-0 text-right">{formatPricePerMillion(price.cacheRead)}</span>
              <span className="w-13 shrink-0 text-right">{formatPricePerMillion(price.output)}</span>
            </div>
          ))}
        </div>
        {dataClaim ? (
          <div className="border-border text-muted-foreground space-y-1 border-t pt-3 text-xs text-pretty">
            <p>
              {tAccess('zdrTitle')}. {tAccess('zdrDescription')}
            </p>
            <p>
              {tAccess('usProvidersTitle')}. {tAccess('usProvidersDescription')}
            </p>
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
