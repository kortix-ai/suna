'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * `ProviderDetail` — one catalog provider in depth: its credential summary, its
 * help link, and every model it declares with capabilities, wire id, context /
 * output limits, pricing and release age.
 *
 * Moved VERBATIM out of the deleted `catalog-tab.tsx`, whose list -> detail ->
 * connect drill-down `provider-connect.tsx` replaced (JAY-510). Only the
 * drill-down went; this browse-before-you-connect view is the one capability
 * that surface had which an inline one-field row does not, so it keeps a home:
 * `ProviderConnect` renders it inline under a More-providers row when that
 * row's model-count button is pressed. `onBack` and `onConnect` both simply
 * close it there — the credential field lives on the row itself now.
 *
 * `useTranslations` is gone with the drill-down: the three keys this view used
 * (`...line576JsxTextBackToProviders`, `...line618JsxTextNewestFirst`,
 * `...line623JsxTextNoModelsDeclared`) resolve to plain English literals in
 * `translations/en.json`, and inlining them matches the house pattern (see
 * `sandbox-tab.tsx`'s header) while letting this render without a
 * `NextIntlClientProvider`.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { useModelPricingLookup } from '@/lib/model-pricing';
import {
  CaretLeftIcon as ChevronLeft,
  ArrowSquareOutIcon as ExternalLink,
} from '@phosphor-icons/react';

import { ModelCapabilityIcons } from './model-capability-icons';
import { ModelIdCopyButton } from './model-id-copy-button';
import {
  formatPricePerMillion,
  formatTokenCount,
  gatewayModelId,
  helpHostnameFromUrl,
  providerCredentialSummary,
  releasedAgo,
} from './utils';

export function ProviderDetail({
  provider,
  isConnected,
  canWrite,
  onBack,
  onConnect,
}: {
  provider: LlmProviderEntry;
  isConnected: boolean;
  canWrite: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const models = provider.models;
  const helpHostname = helpHostnameFromUrl(provider.helpUrl);
  const pricingLookup = useModelPricingLookup(undefined);

  return (
    <div className="space-y-4 px-5 pt-3 pb-5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        {tI18nComplete.raw('textefe5419c900b')}
      </Button>

      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">{provider.label}</span>
            {isConnected && (
              <Badge variant="success" size="sm">
                {tI18nComplete.raw('text22965568d22a')}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {providerCredentialSummary(provider)} · {models.length}{' '}
            {tI18nComplete.raw('text9372c470eead')}
            {models.length === 1 ? '' : 's'}
          </p>
        </div>
        {canWrite && (
          <Button size="sm" className="shrink-0" onClick={onConnect}>
            {isConnected ? 'Reconnect' : 'Connect'}
          </Button>
        )}
      </div>

      {helpHostname && provider.helpUrl && (
        <a
          href={provider.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-1 text-xs"
        >
          <ExternalLink className="size-3 shrink-0" />
          {helpHostname}
        </a>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>
            {tI18nComplete.raw('textd17d2d78d76e')}
            <span className="text-muted-foreground font-normal"> ({models.length})</span>
          </Label>
          <span className="text-muted-foreground/40 text-xs">
            {tI18nComplete.raw('textd5a5a90ac986')}
          </span>
        </div>

        {models.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nComplete.raw('text978fb29c5424')}
          </p>
        ) : (
          <ul className="space-y-2">
            {models.map((model) => {
              const wireId = gatewayModelId(provider, model.id);
              const rates = pricingLookup(provider.id, model.id);
              const ctx = formatTokenCount(model.limit?.context);
              const out = formatTokenCount(model.limit?.output);
              const priceIn = rates ? formatPricePerMillion(rates.inputPer1M) : '';
              const priceOut = rates ? formatPricePerMillion(rates.outputPer1M) : '';
              const hasMeta = !!ctx || !!out || (!!priceIn && !!priceOut);
              return (
                <li
                  key={model.id}
                  className="bg-popover flex items-start gap-3 rounded-md border px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-foreground truncate text-sm font-medium">
                        {model.name}
                      </span>
                      <ModelCapabilityIcons
                        reasoning={model.reasoning}
                        toolCall={model.tool_call}
                        vision={model.attachment}
                      />
                    </div>
                    <div className="flex min-w-0 items-center gap-0.5">
                      <code className="text-muted-foreground/50 min-w-0 truncate font-mono text-xs">
                        {wireId}
                      </code>
                      <ModelIdCopyButton value={wireId} />
                    </div>
                    {hasMeta && (
                      <InlineMeta>
                        {ctx && (
                          <span className="tabular-nums">
                            {ctx} {tI18nComplete.raw('text0230c6b1d833')}
                          </span>
                        )}
                        {out && (
                          <span className="tabular-nums">
                            {out} {tI18nComplete.raw('textc661a1039aa0')}
                          </span>
                        )}
                        {priceIn && priceOut && (
                          <span className="tabular-nums">
                            {priceIn} / {priceOut} {tI18nComplete.raw('text38989e6be9c4')}
                          </span>
                        )}
                      </InlineMeta>
                    )}
                  </div>
                  {model.released && (
                    <span
                      className="text-muted-foreground/50 mt-0.5 shrink-0 text-xs tabular-nums"
                      title={`Released ${model.released}`}
                    >
                      {releasedAgo(model.released)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
