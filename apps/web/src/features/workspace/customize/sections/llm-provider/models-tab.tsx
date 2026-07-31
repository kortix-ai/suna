'use client';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Switch } from '@/components/ui/switch';
import { Tag } from '@/components/ui/tag';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { cn } from '@/lib/utils';
import { useModelStore, useProjectModels } from '@kortix/sdk/react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { ModelCapabilityIcons } from './model-capability-icons';
import { ModelIdCopyButton } from './model-id-copy-button';
import { buildModelGroups } from './model-rows';
import { formatPricePerMillion, formatTokenCount } from './utils';

export function ModelsTab({ projectId, search }: { projectId: string; search: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  // The SAME connection-aware server list the session picker renders
  // (`GET /model-picker`), so the two views can never show different models.
  // Visibility is a CLIENT-side preference persisted in localStorage — the
  // switch here decides whether a model is offered in this browser's picker,
  // not a server-enforced enablement.
  const models = useProjectModels(projectId);
  const modelStore = useModelStore(models);

  const groups = useMemo(() => buildModelGroups(models, search), [models, search]);
  const enabledCount = useMemo(
    () => models.filter((model) => modelStore.isVisible(model)).length,
    [models, modelStore],
  );
  const hasOverrides = modelStore.userPrefs.length > 0;

  if (models.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'componentsProjectsProjectProviderModal.line1258JsxTextConnectAProviderToSeeItsModels',
          )}
        </p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center px-6 text-center">
        <p className="text-muted-foreground/60 text-xs">
          {search ? `No models match "${search}"` : 'No models'}
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 pt-3 pb-4">
      {!search && (
        <div className="flex items-center justify-between gap-3 px-1 pb-2.5">
          <p className="text-muted-foreground/60 text-xs">
            {enabledCount} of {models.length}{' '}
            {tHardcodedUi.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextShownInTheb8c08575',
            )}
          </p>
          {hasOverrides && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-7 shrink-0 px-2 text-xs"
              onClick={() => modelStore.resetVisibility()}
            >
              {tHardcodedUi.raw(
                'autoComponentsProjectsProjectProviderModalJsxTextResetToDefaults75549180',
              )}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.providerID}>
            <div className="flex items-center gap-2 px-1 pb-1">
              <ProviderLogo providerID={group.providerID} name={group.providerName} size="small" />
              <span className="text-foreground/70 text-xs font-medium">{group.providerName}</span>
              <span className="text-muted-foreground/40 ml-auto text-xs">{group.rows.length}</span>
            </div>
            <div className="bg-popover overflow-hidden rounded-md border">
              {group.rows.map(({ model, wireId, isRollingAlias }, i) => {
                const visible = modelStore.isVisible(model);
                const ctx = formatTokenCount(model.contextWindow);
                const priceIn = model.cost ? formatPricePerMillion(model.cost.input) : '';
                const priceOut = model.cost ? formatPricePerMillion(model.cost.output) : '';
                return (
                  // A plain row, NOT a <label>: a <label> binds to the first
                  // labelable control, and the Radix Switch renders a button, so
                  // wrapping the row never associated cleanly. The Switch carries
                  // its own accessible name instead.
                  <div
                    key={wireId}
                    className={cn(
                      'hover:bg-muted/40 flex items-start gap-3 px-3 py-2.5 transition-colors',
                      i > 0 && 'border-border border-t',
                      !visible && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-foreground truncate text-sm">{model.modelName}</span>
                        <ModelCapabilityIcons
                          reasoning={model.capabilities?.reasoning}
                          toolCall={model.capabilities?.toolcall}
                          vision={model.capabilities?.vision}
                        />
                        {/* Same display name as its pinned snapshots — say which
                            row is the one that rolls forward. */}
                        {isRollingAlias && <Tag>latest</Tag>}
                      </div>
                      <div className="flex min-w-0 items-center gap-0.5">
                        <code className="text-muted-foreground/50 min-w-0 truncate font-mono text-xs">
                          {wireId}
                        </code>
                        <ModelIdCopyButton value={wireId} />
                      </div>
                      {(ctx || (priceIn && priceOut)) && (
                        <InlineMeta>
                          {ctx && <span className="tabular-nums">{ctx} ctx</span>}
                          {priceIn && priceOut && (
                            <span className="tabular-nums">
                              {priceIn} / {priceOut} per 1M
                            </span>
                          )}
                        </InlineMeta>
                      )}
                    </div>
                    <Switch
                      checked={visible}
                      aria-label={`Offer ${model.modelName}`}
                      onCheckedChange={(next) => modelStore.setVisibility(model, next)}
                      className="mt-0.5 shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
