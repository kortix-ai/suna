'use client';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import type { FlatModel } from '@/features/session/session-chat-input';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

export function ModelsTab({
  connectedProviders,
  search,
}: {
  connectedProviders: LlmProviderEntry[];
  search: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const flatModels = useMemo<FlatModel[]>(
    () =>
      connectedProviders.flatMap((p) =>
        p.models.map((m) => ({
          providerID: p.id,
          providerName: p.label,
          modelID: m.id,
          modelName: m.name,
          releaseDate: m.released ?? undefined,
        })),
      ),
    [connectedProviders],
  );
  const modelStore = useModelStore(flatModels);

  const enabledCount = useMemo(
    () =>
      flatModels.filter((m) =>
        modelStore.isVisible({ providerID: m.providerID, modelID: m.modelID }),
      ).length,
    [flatModels, modelStore],
  );
  const hasOverrides = modelStore.userPrefs.length > 0;

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return connectedProviders
      .map((provider) => ({
        provider,
        models: provider.models.filter(
          (model) =>
            !q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [connectedProviders, search]);

  if (connectedProviders.length === 0) {
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

  if (grouped.length === 0) {
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
            {enabledCount} of {flatModels.length}{' '}
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
        {grouped.map(({ provider, models }) => (
          <div key={provider.id}>
            <div className="flex items-center gap-2 px-1 pb-1">
              <ProviderLogo providerID={provider.id} name={provider.label} size="small" />
              <span className="text-foreground/70 text-xs font-medium">
                {PROVIDER_LABELS[provider.id] ?? provider.label}
              </span>
              <span className="text-muted-foreground/40 ml-auto text-xs">{models.length}</span>
            </div>
            <div className="border-border/40 bg-background/40 overflow-hidden rounded-2xl border">
              {models.map((model, i) => {
                const key = { providerID: provider.id, modelID: model.id };
                const visible = modelStore.isVisible(key);
                return (
                  <label
                    key={model.id}
                    className={cn(
                      'hover:bg-muted/30 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors',
                      i > 0 && 'border-border/20 border-t',
                      !visible && 'opacity-60',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm">{model.name}</div>
                      <div className="text-muted-foreground/50 mt-0.5 truncate text-xs">
                        {model.id}
                      </div>
                    </div>
                    <Switch
                      checked={visible}
                      onCheckedChange={(c) => modelStore.setVisibility(key, c)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
