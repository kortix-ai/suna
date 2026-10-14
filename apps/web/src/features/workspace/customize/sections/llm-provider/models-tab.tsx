'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * `ModelsTab` — "which models can this project use".
 *
 * ## What this screen is for
 *
 * Explicit model disables block inference. Legacy picker-only preferences
 * remain distinct and are labeled so a hidden model is not mistaken for a
 * blocked model. Default scopes apply to models offered by the picker.
 *
 * ## The row shows real numbers, not a paraphrase
 *
 * A row is the model's name, its capability icons (reasoning / tool calling /
 * vision), its default tags, and the catalog's own figures — context window
 * and customer price per eligible route per 1M tokens. Provider links open this same grouped list.
 * The wire id keeps its use in configuration and
 * lives in a "Copy model ID" item in the row's own menu: one click for the
 * few who need it, no line for everyone who does not.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Switch } from '@/components/ui/switch';
import { Tag } from '@/components/ui/tag';
import { errorToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { ProviderLogoStatus } from '@/features/providers/provider-connect';
import { cn } from '@/lib/utils';
import { isManagedModelId, MANAGED_ENDPOINT_PROVIDERS } from '@kortix/llm-catalog';
import {
  useModelAccess,
  useModelDefaults,
  useModelEnablement,
  useProjectModelPickerCatalog,
  useProjectModels,
  wireToModelKey,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  FolderSimpleIcon as Folder,
  DotsThreeIcon as MoreHorizontal,
  StarIcon as Star,
} from '@phosphor-icons/react';
import { type ReactNode, useMemo, useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';

import { Copy } from '@/features/icon/icons/copy';
import { ModelCapabilityIcons } from './model-capability-icons';
import { buildModelGroups } from './model-rows';
import { formatPricePerMillion, formatTokenCount } from './utils';
import { useSlashFocus } from '@/hooks/utils';

/** A row status pill as the Models board draws it: sentence case, Roobert,
 *  round. `Badge`'s default is the uppercase mono label used elsewhere. */
const STATUS_PILL = 'rounded-full font-sans text-xs tracking-normal normal-case';

/**
 * `search` used to be driven by the provider modal's always-on search bar,
 * which JAY-510 deleted (it sat above the tabs and filtered whichever tab
 * happened to be open). Passing `''` would have silently dropped model search,
 * so this tab owns its own input when no host drives one — one search box per
 * thing being searched, instead of one box for three different lists.
 */
export function ModelsTab({
  projectId,
  search: hostSearch,
  canWrite = false,
}: {
  projectId: string;
  search?: string;
  canWrite?: boolean;
}) {
  const tAccess = useTranslations('modelAccess');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tList = useTranslations('modelsList');
  const [ownSearch, setOwnSearch] = useState('');
  const search = hostSearch ?? ownSearch;
  const ownsSearch = hostSearch === undefined;

  // The SAME server list the session picker renders (`GET /model-picker`), so
  // the two views can never show different models — and each model's `enabled`
  // flag is resolved server-side and enforced by the gateway, so a switch here
  // is the one and only thing deciding whether it appears there.
  const models = useProjectModels(projectId);
  const pickerCatalog = useProjectModelPickerCatalog(projectId);
  const enablement = useModelEnablement(projectId);
  const access = useModelAccess(projectId);
  // Setting the project default from here is what makes the locked row
  // actionable: the only way to turn the default off is to make something else
  // the default, so the control for that belongs on the same screen.
  //
  // This is also the home for the ACCOUNT default ("my default model"). It
  // used to be a button stacked under the session model picker, alongside two
  // other scopes, where nothing on screen said which model held any of them.
  // Here both scopes sit on the row they apply to and each one BADGES the
  // model that currently holds it — see the `Default` / `Your default` tags
  // below. The picker keeps a one-click star for the account default only;
  // this tab is where the scopes are actually managed.
  const defaults = useModelDefaults(projectId);

  const groups = useMemo(() => buildModelGroups(models, search), [models, search]);
  const enabledCount = useMemo(() => models.filter((m) => m.enabled).length, [models]);
  // Only when this tab draws its own search; a host's search is the host's.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef, ownsSearch && models.length > 0);

  if (models.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">{tI18nComplete.raw('textc7a9aa43558f')}</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          {tI18nComplete.raw('text2cedbc7a36d8')}
        </p>
      </div>
    );
  }

  // One managed model clears the ZDR + US claim when it serves from Kortix's
  // own managed pool. Only a Morph route breaks it; a missing price feed still
  // serves from the verified US ZDR pool.
  const holdsDataClaim = (modelID: string) => {
    const routes = pickerCatalog?.managedPricingRoutes?.[modelID];
    return isManagedModelId(modelID) && !routes?.some((route) => route.route === 'morph');
  };

  // No horizontal padding of its own: `CapabilityPageShell` supplies the page
  // column, and 20px more here indented this tab's content past the tab strip
  // that selects it.
  return (
    <div className="pb-4">
      {/*
        The search field, the "N of M on" count and "Start over" share ONE row,
        and that row's height never changes. "Start over" appears the instant
        you flip your first switch; as a row of its own it pushed the whole list
        down under the cursor that had just clicked it (+25.75px, measured).
      */}
      <div className="mb-4 flex items-center gap-3">
        {ownsSearch && (
          <InputGroupSearch className="min-w-0 flex-1">
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              ref={searchRef}
              type="text"
              placeholder={tI18nComplete.raw('text2380f018cc45')}
              autoComplete="off"
              value={ownSearch}
              onChange={(event) => setOwnSearch(event.target.value)}
            />
            <InputGroupSearchClear onClick={() => setOwnSearch('')} />
          </InputGroupSearch>
        )}
        {!enablement.usingDefaults && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canWrite || enablement.isUpdating || access.isUpdating}
            className="text-muted-foreground hover:text-foreground h-7 shrink-0 px-2 text-xs"
            onClick={() =>
              void enablement
                .resetToDefaults()
                .catch((error: unknown) =>
                  errorToast(error instanceof Error ? error.message : tAccess('resetError')),
                )
            }
          >
            {tI18nComplete.raw('text5eed7e9fc8f3')}
          </Button>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {tList('onCount', { on: enabledCount, total: models.length })}
        </span>
      </div>

      {/* The no-match message lives HERE, in the list's slot, never as an
          early return above the search row: returned early, a query that
          matched nothing unmounted the input and its clear button. */}
      {groups.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
          <p className="text-muted-foreground text-xs">
            {search
              ? tI18nComplete('textb475669b9d30', { value0: search })
              : tI18nComplete.raw('textb12da9202e8c')}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const providerDisabled =
              access.data?.disabledProviders.includes(group.providerID) ?? false;
            const groupOn = group.rows.filter(({ model }) => model.enabled).length;
            const dataClaim =
              group.providerID === 'kortix' &&
              group.rows.every(({ model }) => holdsDataClaim(model.modelID));
            return (
              <section
                key={group.providerID}
                data-provider-group={group.providerID}
                className="bg-popover overflow-hidden rounded-lg border"
              >
                <header className="border-border flex items-center gap-3 border-b px-4 py-3">
                  <ProviderLogoStatus
                    providerId={group.providerID}
                    label={group.providerName}
                    status={
                      providerDisabled
                        ? 'none'
                        : group.providerID === 'kortix'
                          ? 'included'
                          : 'connected'
                    }
                    size="medium"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {group.providerName}
                    </p>
                    {/* One quiet line, not a green panel: both facts are
                        reassurance, and the detail lives one hover away.
                        `tabIndex` keeps each hint reachable by keyboard. */}
                    {dataClaim ? (
                      <p className="text-muted-foreground text-xs">
                        <Hint label={tAccess('zdrDescription')} side="top" className="max-w-xs">
                          <span tabIndex={0} className="cursor-help">
                            {tAccess('zdrTitle')}
                          </span>
                        </Hint>
                        {' · '}
                        <Hint label={tAccess('usProvidersDescription')} side="top" className="max-w-xs">
                          <span tabIndex={0} className="cursor-help">
                            {tAccess('usProvidersTitle')}
                          </span>
                        </Hint>
                      </p>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {tList('onCount', { on: groupOn, total: group.rows.length })}
                  </span>
                  <ProviderSwitch
                    access={access}
                    providerId={group.providerID}
                    name={group.providerName}
                    canWrite={canWrite}
                  />
                </header>
                {group.rows.map(({ model, wireId, isRollingAlias }) => {
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
                })}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A whole provider on or off for this project. Credentials stay either way.
 * The project default's provider cannot be turned off until the default moves
 * elsewhere — the same lock the provider sheet's switch applies.
 */
function ProviderSwitch({
  access,
  providerId,
  name,
  canWrite,
}: {
  access: ReturnType<typeof useModelAccess>;
  providerId: string;
  name: string;
  canWrite: boolean;
}) {
  const tAccess = useTranslations('modelAccess');
  if (!access.data?.enforced) return null;
  const enabled = !access.data.disabledProviders.includes(providerId);
  const locked = access.defaultProvider === providerId && enabled;
  return (
    <Hint label={locked ? tAccess('defaultProviderHint') : tAccess('credentialsHint')} side="bottom">
      <span className="inline-flex shrink-0">
        <Switch
          checked={enabled}
          disabled={!canWrite || access.isUpdating || locked}
          aria-label={tAccess('enableProvider', { name })}
          onCheckedChange={(next) =>
            void access
              .setEnabled({ target: 'provider', id: providerId, enabled: next })
              .catch((error: unknown) =>
                errorToast(error instanceof Error ? error.message : tAccess('providerError')),
              )
          }
        />
      </span>
    </Hint>
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
