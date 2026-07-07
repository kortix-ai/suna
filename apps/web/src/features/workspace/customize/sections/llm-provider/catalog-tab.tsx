'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { ChevronLeft, ChevronRight, ExternalLink, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { ApiKeyConnectForm } from './api-key-connect-form';
import { CustomProviderForm } from './custom-provider-form';
import type { CatalogSubview } from './types';
import { helpHostnameFromUrl, providerCredentialSummary, releasedAgo } from './utils';

const ROW =
  'group bg-popover hover:bg-muted/40 flex w-full items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-colors';

export function CatalogTab({
  projectId,
  connectedIds,
  search,
  subview,
  setSubview,
}: {
  projectId: string;
  connectedIds: Set<string>;
  search: string;
  subview: CatalogSubview;
  setSubview: (next: CatalogSubview) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return LLM_PROVIDERS;
    return LLM_PROVIDERS.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.envVars.some((v) => v.toLowerCase().includes(q)),
    );
  }, [search]);

  if (subview.kind === 'detail') {
    const provider = LLM_PROVIDER_BY_ID.get(subview.providerId);
    if (!provider) {
      setSubview({ kind: 'list' });
      return null;
    }
    return (
      <ProviderDetail
        provider={provider}
        isConnected={connectedIds.has(provider.id)}
        onBack={() => setSubview({ kind: 'list' })}
        onConnect={() => setSubview({ kind: 'connect', providerId: provider.id })}
      />
    );
  }

  if (subview.kind === 'connect') {
    const provider = LLM_PROVIDER_BY_ID.get(subview.providerId);
    if (!provider) {
      setSubview({ kind: 'list' });
      return null;
    }
    return (
      <ApiKeyConnectForm
        projectId={projectId}
        provider={provider}
        onBack={() => setSubview({ kind: 'detail', providerId: provider.id })}
        onConnected={() => setSubview({ kind: 'list' })}
      />
    );
  }

  if (subview.kind === 'custom') {
    return (
      <CustomProviderForm
        projectId={projectId}
        onBack={() => setSubview({ kind: 'list' })}
        onDone={() => setSubview({ kind: 'list' })}
      />
    );
  }

  return (
    <div className="space-y-3 px-5 pt-3 pb-4">
      <button type="button" className={`${ROW} border-dashed`} onClick={() => setSubview({ kind: 'custom' })}>
        <span className="border-border/60 text-muted-foreground/70 flex size-9 shrink-0 items-center justify-center rounded-sm border border-dashed">
          <Plus className="size-4 shrink-0" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line492JsxTextCustomProvider')}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line495JsxTextConnectAnyOpenaiCompatibleEndpointWithYourOwn',
            )}
          </p>
        </div>
        <ChevronRight className="text-muted-foreground/40 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
      </button>

      {filtered.length === 0 ? (
        <EmptyState size="sm" title={search ? `No providers match "${search}"` : 'No providers'} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((provider) => {
            const isConnected = connectedIds.has(provider.id);
            return (
              <li key={provider.id}>
                <button
                  type="button"
                  className={ROW}
                  onClick={() => setSubview({ kind: 'detail', providerId: provider.id })}
                >
                  <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-foreground truncate text-sm font-medium">
                        {PROVIDER_LABELS[provider.id] ?? provider.label}
                      </span>
                      {isConnected && (
                        <Badge variant="success" size="sm">
                          Connected
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">{provider.hint}</p>
                  </div>
                  <ChevronRight className="text-muted-foreground/40 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProviderDetail({
  provider,
  isConnected,
  onBack,
  onConnect,
}: {
  provider: LlmProviderEntry;
  isConnected: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const models = provider.models;
  const helpHostname = helpHostnameFromUrl(provider.helpUrl);

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
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line576JsxTextBackToProviders')}
      </Button>

      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">
              {PROVIDER_LABELS[provider.id] ?? provider.label}
            </span>
            {isConnected && (
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {providerCredentialSummary(provider)} · {models.length} model
            {models.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={onConnect}>
          {isConnected ? 'Reconnect' : 'Connect'}
        </Button>
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
            Models
            <span className="text-muted-foreground font-normal"> ({models.length})</span>
          </Label>
          <span className="text-muted-foreground/40 text-xs">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line618JsxTextNewestFirst')}
          </span>
        </div>

        {models.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line623JsxTextNoModelsDeclared')}
          </p>
        ) : (
          <ul className="space-y-2">
            {models.map((model) => (
              <li
                key={model.id}
                className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-sm font-medium">{model.name}</div>
                  <div className="text-muted-foreground/50 mt-0.5 truncate text-xs">{model.id}</div>
                </div>
                {model.released && (
                  <span
                    className="text-muted-foreground/50 shrink-0 text-xs tabular-nums"
                    title={`Released ${model.released}`}
                  >
                    {releasedAgo(model.released)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
