'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/runtime/provider-refresh';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import {
  deleteProjectSecret,
  setActiveHarnessConnection,
  type HarnessConnection,
  type HarnessId,
} from '@kortix/sdk/projects-client';
import { invalidateComposerCapabilityQueries } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';
import { providerCredentialSummary, providerModelsSummary } from './utils';

export function ConnectedTab({
  projectId,
  connectedProviders,
  connections,
  search,
  onAddProvider,
  canWrite = false,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  connections: HarnessConnection[];
  search: string;
  onAddProvider: () => void;
  canWrite?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      const connectionKinds = provider.id === 'codex'
        ? ['codex_subscription']
        : provider.id === 'claude-subscription'
          ? ['claude_subscription']
          : provider.id === 'openai'
            ? ['openai_api_key']
            : provider.id === 'anthropic'
              ? ['anthropic_api_key']
              : provider.id === 'custom-rest'
                ? ['openai_compatible', 'anthropic_compatible']
                : [];
      await Promise.all(
        connections
          .filter((connection) => connectionKinds.includes(connection.kind))
          .flatMap((connection) => connection.active_for)
          .map((harness) => setActiveHarnessConnection(projectId, harness, null)),
      );
      const names =
        provider.id === 'codex'
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
      void invalidateComposerCapabilityQueries(queryClient, projectId);
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to disconnect'),
  });
  const selectRoute = useMutation({
    mutationFn: ({ harness, connectionId }: { harness: HarnessId; connectionId: HarnessConnection['id'] | null }) =>
      setActiveHarnessConnection(projectId, harness, connectionId),
    onSuccess: () => {
      successToast('Harness authentication route updated');
      void invalidateComposerCapabilityQueries(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to update authentication route'),
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

  const confirmProvider = confirmId
    ? (connectedProviders.find((p) => p.id === confirmId) ??
      LLM_PROVIDER_BY_ID.get(confirmId) ??
      null)
    : null;

  return (
    <>
      <section className="space-y-2 px-5 pt-3">
        <div>
          <p className="text-sm font-medium">Active harness routes</p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            Choose exactly which connection each ACP harness uses. Automatic prefers the managed gateway, then one unambiguous native connection.
          </p>
        </div>
        <ul className="space-y-2">
          {(['claude', 'codex', 'opencode', 'pi'] as const).map((harness) => {
            const compatible = connections.filter(
              (connection) => connection.ready && connection.compatible_harnesses.includes(harness),
            );
            const active = compatible.find((connection) => connection.active_for.includes(harness));
            return (
              <li key={harness} className="bg-popover flex min-h-12 items-center gap-3 rounded-md border px-4 py-2">
                <Badge variant="outline" size="sm" className="capitalize">{harness}</Badge>
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {active?.label ?? 'Automatic resolution'}
                </span>
                <Select
                  value={active?.id ?? 'automatic'}
                  disabled={!canWrite || selectRoute.isPending}
                  onValueChange={(value) => selectRoute.mutate({
                    harness,
                    connectionId: value === 'automatic' ? null : value as HarnessConnection['id'],
                  })}
                >
                  <SelectTrigger size="sm" className="w-[190px]" aria-label={`${harness} authentication route`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">Automatic</SelectItem>
                    {compatible.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>{connection.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            );
          })}
        </ul>
      </section>
      {connectedProviders.length === 0 ? (
        <div className="px-5 pt-3 pb-4">
          <EmptyState
            size="sm"
            icon={Plug}
            title={tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line300JsxTextNoProvidersConnectedYet',
            )}
            action={canWrite ? (
              <Button variant="outline" size="sm" onClick={onAddProvider}>
                {tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line302JsxTextAddProvider',
                )}
              </Button>
            ) : undefined}
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-5 pt-3 pb-4">
          <EmptyState
            size="sm"
            title={`${tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextNoConnectedProvidersMatchLdquo')}${search}${tHardcodedUi.raw('componentsProjectsProjectProviderModal.line312JsxTextRdquo')}`}
          />
        </div>
      ) : (
      <ul className="space-y-2 px-5 pt-3 pb-4">
        {filtered.map((provider) => {
          const busy = disconnect.isPending && disconnect.variables?.id === provider.id;
          return (
            <li
              key={provider.id}
              className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
            >
              <ProviderLogo
                providerID={
                  provider.id === 'claude-subscription'
                    ? 'anthropic'
                    : provider.id === 'codex'
                      ? 'openai'
                      : provider.id
                }
                name={provider.label}
                size="default"
              />
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
                    ? `${provider.hint} · ${providerModelsSummary(provider)}`
                    : `${providerCredentialSummary(provider)} · ${providerModelsSummary(provider)}`}
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
      )}

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
            </span>
          ) : null
        }
      />
    </>
  );
}
