'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { ChevronLeft, ChevronRight, ExternalLink, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import type { CatalogSubview } from './types';
import { helpHostnameFromUrl, providerCredentialSummary, releasedAgo } from './utils';
import { ApiKeyConnectForm } from './api-key-connect-form';
import { CustomProviderForm } from './custom-provider-form';

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
      <SectionCard className="border-dashed" flush>
        <List>
          <ListRow
            leading={
              <span className="border-border/60 text-muted-foreground/70 flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed">
                <Plus className="h-4 w-4" />
              </span>
            }
            title={tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line492JsxTextCustomProvider',
            )}
            subtitle={
              <span className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line495JsxTextConnectAnyOpenaiCompatibleEndpointWithYourOwn',
                )}
              </span>
            }
            trailing={<ChevronRight className="text-muted-foreground/40 h-4 w-4" />}
            onClick={() => setSubview({ kind: 'custom' })}
          />
        </List>
      </SectionCard>

      {filtered.length === 0 ? (
        <EmptyState
          size="sm"
          title={search ? `No providers match "${search}"` : 'No providers'}
        />
      ) : (
        <SectionCard flush>
          <List>
            {filtered.map((provider) => {
              const isConnected = connectedIds.has(provider.id);
              return (
                <ListRow
                  key={provider.id}
                  leading={
                    <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
                  }
                  title={PROVIDER_LABELS[provider.id] ?? provider.label}
                  badges={
                    isConnected ? (
                      <Badge variant="success" size="sm">
                        Connected
                      </Badge>
                    ) : undefined
                  }
                  subtitle={<span className="text-muted-foreground text-xs">{provider.hint}</span>}
                  trailing={<ChevronRight className="text-muted-foreground/40 h-4 w-4" />}
                  onClick={() => setSubview({ kind: 'detail', providerId: provider.id })}
                />
              );
            })}
          </List>
        </SectionCard>
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
    <div className="space-y-3 px-5 pt-3 pb-5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line576JsxTextBackToProviders')}
      </Button>

      <SectionCard
        action={
          <Button size="sm" onClick={onConnect}>
            {isConnected ? 'Reconnect' : 'Connect'}
          </Button>
        }
      >
        <div className="flex items-center gap-3">
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
        </div>
      </SectionCard>

      {helpHostname && provider.helpUrl && (
        <a
          href={provider.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-1 text-xs"
        >
          <ExternalLink className="h-3 w-3" />
          {helpHostname}
        </a>
      )}

      <SectionCard
        title="Models"
        count={models.length}
        flush
        action={
          <span className="text-muted-foreground/40 text-xs">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line618JsxTextNewestFirst')}
          </span>
        }
      >
        {models.length === 0 ? (
          <div className="text-muted-foreground px-6 py-6 text-center text-xs">
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line623JsxTextNoModelsDeclared',
            )}
          </div>
        ) : (
          <List>
            {models.map((model) => (
              <ListRow
                key={model.id}
                title={model.name}
                subtitle={<span className="text-muted-foreground/50 text-xs">{model.id}</span>}
                trailing={
                  model.released ? (
                    <span
                      className="text-muted-foreground/50 text-xs tabular-nums"
                      title={`Released ${model.released}`}
                    >
                      {releasedAgo(model.released)}
                    </span>
                  ) : undefined
                }
              />
            ))}
          </List>
        )}
      </SectionCard>
    </div>
  );
}
