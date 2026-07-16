'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import {
  deleteProjectSecret,
  promoteProjectSecretToShared,
} from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plug, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';
import { providerCredentialSummary } from './utils';

export function ConnectedTab({
  projectId,
  connectedProviders,
  privateOnlyProviderIds,
  search,
  onAddProvider,
  canWrite = false,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  /** Connected providers whose key only resolves via the viewer's PRIVATE
   *  override — nobody else on the project can use it. */
  privateOnlyProviderIds?: Set<string>;
  search: string;
  onAddProvider: () => void;
  canWrite?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const makeShared = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      await Promise.all(
        provider.envVars.map((envVar) => promoteProjectSecretToShared(projectId, envVar)),
      );
      return provider;
    },
    onSuccess: (provider) => {
      successToast(`${provider.label} key is now shared with the whole project`);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: provider.id });
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to share key'),
  });

  const disconnect = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      const names =
        provider.id === 'openai' || provider.id === 'codex'
          ? [
              ...provider.envVars,
              CODEX_AUTH_JSON_SECRET_NAME,
              LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
            ]
          : provider.envVars;
      await Promise.all(
        names.map((envVar) => deleteProjectSecret(projectId, envVar).catch(() => undefined)),
      );
      return provider;
    },
    onSuccess: (provider) => {
      successToast(`${provider.label} disconnected`);
      setConfirmId(null);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to disconnect'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connectedProviders;
    return connectedProviders.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.envVars.some((v) => v.toLowerCase().includes(q)),
    );
  }, [connectedProviders, search]);

  if (connectedProviders.length === 0) {
    return (
      <div className="px-5 pt-3 pb-4">
        <EmptyState
          size="sm"
          icon={Plug}
          title={tHardcodedUi.raw(
            'componentsProjectsProjectProviderModal.line300JsxTextNoProvidersConnectedYet',
          )}
          action={
            canWrite ? (
              <Button variant="outline" size="sm" onClick={onAddProvider}>
                {tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line302JsxTextAddProvider',
                )}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="px-5 pt-3 pb-4">
        <EmptyState
          size="sm"
          title={`${tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextNoConnectedProvidersMatchLdquo')}${search}${tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextRdquo')}`}
        />
      </div>
    );
  }

  const confirmProvider = confirmId
    ? (connectedProviders.find((p) => p.id === confirmId) ?? LLM_PROVIDER_BY_ID.get(confirmId) ?? null)
    : null;

  return (
    <>
      <ul className="space-y-2 px-5 pt-3 pb-4">
        {filtered.map((provider) => {
          const busy = disconnect.isPending && disconnect.variables?.id === provider.id;
          const isPrivateOnly = privateOnlyProviderIds?.has(provider.id) ?? false;
          const sharing = makeShared.isPending && makeShared.variables?.id === provider.id;
          return (
            <li
              key={provider.id}
              className="bg-popover group flex flex-col gap-2 rounded-md border px-4 py-2.5 transition-colors"
            >
              <div className="flex items-center gap-3">
                <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-foreground truncate text-sm font-medium">
                      {PROVIDER_LABELS[provider.id] ?? provider.label}
                    </span>
                    {provider.managed && (
                      <Badge size="sm" variant="secondary">
                        Managed
                      </Badge>
                    )}
                    {isPrivateOnly && (
                      <Badge size="sm" variant="warning">
                        Only you
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {provider.managed
                      ? `${provider.hint} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
                      : `${providerCredentialSummary(provider)} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                {canWrite && !provider.managed && (
                  <Hint label="Disconnect">
                    <Button
                      type="button"
                      onClick={() => setConfirmId(provider.id)}
                      disabled={disconnect.isPending}
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground/40 hover:text-foreground shrink-0"
                      aria-label="Disconnect"
                    >
                      {busy ? (
                        <Loading className="size-3.5 shrink-0" />
                      ) : (
                        <Unplug className="size-3.5 shrink-0" />
                      )}
                    </Button>
                  </Hint>
                )}
              </div>

              {isPrivateOnly && (
                <InfoBanner tone="warning" icon={AlertTriangle} className="rounded-lg">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Only your sessions can use this key — other members&apos; sessions can&apos;t
                      route with it.
                    </span>
                    {canWrite && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 shrink-0 px-2 text-xs"
                        disabled={makeShared.isPending}
                        onClick={() => makeShared.mutate(provider)}
                      >
                        {sharing ? <Loading className="size-3 shrink-0" /> : null}
                        Make shared
                      </Button>
                    )}
                  </div>
                </InfoBanner>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={!!confirmId}
        onOpenChange={(open) => !open && setConfirmId(null)}
        title={tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line361JsxTextDisconnectProvider',
        )}
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="size-3.5 shrink-0" />}
        isPending={disconnect.isPending}
        onConfirm={() => confirmProvider && disconnect.mutate(confirmProvider)}
        description={
          confirmProvider ? (
            <span className="text-xs">
              Remove <span className="text-foreground font-medium">{confirmProvider.label}</span>
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line366JsxTextThisDeletes')}{' '}
              {confirmProvider.envVars.length === 1 ? (
                <>
                  the{' '}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {confirmProvider.envVars[0]}
                  </code>{' '}
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line374JsxTextProjectSecret',
                  )}
                </>
              ) : (
                <>
                  {confirmProvider.envVars.length}
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line378JsxTextProjectSecrets',
                  )}
                  {confirmProvider.envVars.map((envVar, index) => (
                    <span key={envVar}>
                      {index > 0 && ', '}
                      <code className="bg-muted rounded px-1 py-0.5 font-mono">{envVar}</code>
                    </span>
                  ))}
                  ).
                </>
              )}{' '}
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line388JsxTextYouAposLlNeedToReconnectToUse',
              )}
            </span>
          ) : null
        }
      />
    </>
  );
}
