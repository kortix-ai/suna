'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { deleteProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';
import { providerCredentialSummary } from './utils';

export function ConnectedTab({
  projectId,
  connectedProviders,
  search,
  onAddProvider,
  canWrite = false,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  search: string;
  onAddProvider: () => void;
  canWrite?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
          return (
            <li
              key={provider.id}
              className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
            >
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
