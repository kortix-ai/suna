'use client';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Switch } from '@/components/ui/switch';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { useModelPricingLookup } from '@/lib/model-pricing';
import { cn } from '@/lib/utils';
import { useModelEnablement } from '@kortix/sdk/react';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { ModelCapabilityIcons } from './model-capability-icons';
import { ModelIdCopyButton } from './model-id-copy-button';
import {
  formatPricePerMillion,
  formatTokenCount,
  gatewayModelId,
  helpHostnameFromUrl,
} from './utils';

export function ModelsTab({
  projectId,
  connectedProviders,
  search,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  search: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pricingLookup = useModelPricingLookup(undefined);

  // Enablement is SERVER-owned (the gateway enforces it): each switch persists
  // to `PUT /projects/:id/model-enablement`, not localStorage. `gatewayModelId`
  // gives each row its wire id — the key the server stores.
  const enablement = useModelEnablement(projectId);

  const rows = useMemo(
    () => connectedProviders.flatMap((p) => p.models.map((m) => ({ provider: p, model: m }))),
    [connectedProviders],
  );

  const enabledCount = useMemo(
    () =>
      rows.filter((row) => enablement.isEnabled(gatewayModelId(row.provider, row.model.id))).length,
    [rows, enablement],
  );
  const hasOverrides = enablement.disabledModels.size > 0;

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byProvider = new Map<string, { provider: LlmProviderEntry; rows: typeof rows }>();
    for (const row of rows) {
      if (
        q &&
        !row.model.name.toLowerCase().includes(q) &&
        !row.model.id.toLowerCase().includes(q)
      ) {
        continue;
      }
      const existing = byProvider.get(row.provider.id);
      if (existing) existing.rows.push(row);
      else byProvider.set(row.provider.id, { provider: row.provider, rows: [row] });
    }
    return Array.from(byProvider.values());
  }, [rows, search]);

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
            {enabledCount} of {rows.length}{' '}
            {tHardcodedUi.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextShownInTheb8c08575',
            )}
          </p>
          {hasOverrides && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-7 shrink-0 px-2 text-xs"
              onClick={() => void enablement.enableAll()}
            >
              {tHardcodedUi.raw(
                'autoComponentsProjectsProjectProviderModalJsxTextResetToDefaults75549180',
              )}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-3">
        {grouped.map(({ provider, rows: providerRows }) => {
          const helpHostname = helpHostnameFromUrl(provider.helpUrl);
          return (
            <div key={provider.id}>
              <div className="flex items-center gap-2 px-1 pb-1">
                <ProviderLogo providerID={provider.id} name={provider.label} size="small" />
                <span className="text-foreground/70 text-xs font-medium">{provider.label}</span>
                {helpHostname && provider.helpUrl && (
                  <a
                    href={provider.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground/50 hover:text-foreground inline-flex items-center gap-0.5 text-[11px] transition-colors"
                  >
                    <ExternalLink className="size-2.5 shrink-0" />
                    {helpHostname}
                  </a>
                )}
                <span className="text-muted-foreground/40 ml-auto text-xs">
                  {providerRows.length}
                </span>
              </div>
              <div className="bg-popover overflow-hidden rounded-md border">
                {providerRows.map(({ model }, i) => {
                  const wireId = gatewayModelId(provider, model.id);
                  const visible = enablement.isEnabled(wireId);
                  const rates = pricingLookup(provider.id, model.id);
                  const ctx = formatTokenCount(model.limit?.context);
                  const out = formatTokenCount(model.limit?.output);
                  const priceIn = rates ? formatPricePerMillion(rates.inputPer1M) : '';
                  const priceOut = rates ? formatPricePerMillion(rates.outputPer1M) : '';
                  const hasMeta = !!ctx || !!out || (!!priceIn && !!priceOut);
                  return (
                    <label
                      key={model.id}
                      className={cn(
                        'hover:bg-muted/40 flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors',
                        i > 0 && 'border-border border-t',
                        !visible && 'opacity-60',
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-foreground truncate text-sm">{model.name}</span>
                          <ModelCapabilityIcons model={model} />
                        </div>
                        <div className="flex min-w-0 items-center gap-0.5">
                          <code className="text-muted-foreground/50 min-w-0 truncate font-mono text-xs">
                            {wireId}
                          </code>
                          <ModelIdCopyButton value={wireId} />
                        </div>
                        {hasMeta && (
                          <InlineMeta>
                            {ctx && <span className="tabular-nums">{ctx} ctx</span>}
                            {out && <span className="tabular-nums">{out} max out</span>}
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
                        disabled={enablement.isUpdating}
                        onCheckedChange={(c) => void enablement.setEnabled(wireId, c)}
                        className="mt-0.5 shrink-0"
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
