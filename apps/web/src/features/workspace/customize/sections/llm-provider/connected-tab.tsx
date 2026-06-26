'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { deletePersonalProjectSecret, deleteProjectSecret } from '@/lib/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { providerCredentialSummary } from './utils';
import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';

export function ConnectedTab({
  projectId,
  connectedProviders,
  search,
  onAddProvider,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  search: string;
  onAddProvider: () => void;
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
        names.flatMap((envVar) => [
          deleteProjectSecret(projectId, envVar).catch(() => undefined),
          deletePersonalProjectSecret(projectId, envVar).catch(() => undefined),
        ]),
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
            <Button variant="outline" size="sm" onClick={onAddProvider}>
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line302JsxTextAddProvider')}
            </Button>
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
      <div className="px-5 pt-3 pb-4">
        <SectionCard flush count={filtered.length}>
          <List>
            {filtered.map((provider) => (
              <ListRow
                key={provider.id}
                leading={
                  <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
                }
                title={PROVIDER_LABELS[provider.id] ?? provider.label}
                badges={
                  provider.managed ? (
                    <Badge size="sm" variant="secondary">
                      Managed
                    </Badge>
                  ) : undefined
                }
                subtitle={
                  <span className="text-muted-foreground truncate text-xs">
                    {provider.managed
                      ? `${provider.hint} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
                      : `${providerCredentialSummary(provider)} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`}
                  </span>
                }
                trailing={
                  !provider.managed ? (
                    <Button
                      type="button"
                      onClick={() => setConfirmId(provider.id)}
                      disabled={disconnect.isPending}
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground/40 hover:bg-muted hover:text-foreground"
                      title="Disconnect"
                    >
                      {disconnect.isPending && disconnect.variables?.id === provider.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Unplug className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </List>
        </SectionCard>
      </div>

      <AlertDialog open={!!confirmId} onOpenChange={(open) => !open && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line361JsxTextDisconnectProvider',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirmProvider && (
                <>
                  Remove{' '}
                  <span className="text-foreground font-medium">{confirmProvider.label}</span>
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line366JsxTextThisDeletes',
                  )}{' '}
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
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmProvider && disconnect.mutate(confirmProvider)}
              className={buttonVariants({ variant: 'destructive' })}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
