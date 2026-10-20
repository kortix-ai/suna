'use client';

import { ModelsTabGroup } from './models-tab-group';
export { ModelPriceHoverCard } from './models-tab-row';

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
import { errorToast } from '@/components/ui/toast';
import { isManagedModelId } from '@kortix/llm-catalog';
import {
  useModelAccess,
  useModelDefaults,
  useModelEnablement,
  useProjectModelPickerCatalog,
  useProjectModels,
} from '@kortix/sdk/react';
import { useMemo, useRef, useState } from 'react';

import {
InputGroupSearch,
InputGroupSearchClear,
InputGroupSearchIcon,
InputGroupSearchInput,
} from '@/components/ui/input-group';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';

import { useSlashFocus } from '@/hooks/utils';
import { buildModelGroups } from './model-rows';

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
  // Prices below are the provider's base price; the fee is added when the call bills.
  const platformFee = pickerCatalog?.platformFeePercent;
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
            return (
              <ModelsTabGroup
                key={group.providerID}
                group={group}
                access={access}
                enablement={enablement}
                defaults={defaults}
                pickerCatalog={pickerCatalog}
                canWrite={canWrite}
                holdsDataClaim={holdsDataClaim}
                platformFee={platformFee}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
