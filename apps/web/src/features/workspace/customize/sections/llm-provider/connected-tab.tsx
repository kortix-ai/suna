'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import {
  deleteProjectSecret,
  type GatewayProviderVerifyResult,
  verifyGatewayProvider,
} from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';
import { providerCredentialSummary } from './utils';

// GAP C1 — "Connected" only means a secret row exists in project_secrets; it
// never proves the key actually works. This row action calls the gateway's
// cheap one-request verify endpoint (POST .../gateway/providers/:id/verify)
// on demand and renders the classification inline — never on mount, so
// connecting stays exactly as fast/cheap as it is today and verification is
// purely opt-in. Not offered for `codex` (a ChatGPT OAuth subscription, not
// an API key — no catalog model exists to ping it against) or managed rows
// (no BYOK credential to verify).
function verifyAffordanceIcon(status: GatewayProviderVerifyResult['status'] | undefined) {
  if (status === 'verified') return { Icon: ShieldCheck, className: 'text-kortix-green' };
  if (status === 'invalid' || status === 'not_connected') {
    return { Icon: ShieldAlert, className: 'text-kortix-red' };
  }
  if (status === 'unknown') return { Icon: ShieldQuestion, className: 'text-kortix-yellow' };
  return { Icon: ShieldQuestion, className: 'text-muted-foreground/40' };
}

function verifyAffordanceLabel(result: GatewayProviderVerifyResult | undefined): string {
  if (!result) return 'Verify this key works';
  if (result.status === 'verified') return 'Verified — the provider accepted the key';
  return result.message || 'Verify this key works';
}

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
  const [verifyResults, setVerifyResults] = useState<Record<string, GatewayProviderVerifyResult>>(
    {},
  );

  const verify = useMutation({
    mutationFn: (provider: LlmProviderEntry) => verifyGatewayProvider(projectId, provider.id),
    onSuccess: (result, provider) => {
      setVerifyResults((current) => ({ ...current, [provider.id]: result }));
      if (result.status === 'verified') {
        successToast(`${provider.label} key verified`);
      } else if (result.status === 'invalid' || result.status === 'not_connected') {
        errorToast(result.message || `${provider.label} key rejected`);
      } else {
        warningToast(result.message || `Couldn't verify ${provider.label}`);
      }
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : "Couldn't verify — try again"),
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
          description={
            canWrite
              ? 'Connect an LLM provider to give this project its own models. Keys are encrypted and shared with everyone on the project.'
              : 'No LLM providers have been connected to this project yet.'
          }
          action={
            canWrite ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onAddProvider}>
                <Plus className="size-3.5 shrink-0" />
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
    ? (connectedProviders.find((p) => p.id === confirmId) ??
      LLM_PROVIDER_BY_ID.get(confirmId) ??
      null)
    : null;

  return (
    <>
      <ul className="space-y-2 px-5 pt-3 pb-4">
        {filtered.map((provider) => {
          const busy = disconnect.isPending && disconnect.variables?.id === provider.id;
          const verifyBusy = verify.isPending && verify.variables?.id === provider.id;
          const verifyResult = verifyResults[provider.id];
          const verifyOffered = !provider.managed && provider.id !== 'codex';
          const { Icon: VerifyIcon, className: verifyIconClassName } = verifyAffordanceIcon(
            verifyResult?.status,
          );
          return (
            <li
              key={provider.id}
              className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
            >
              <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground truncate text-sm font-medium">
                    {provider.label}
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
              {verifyOffered && (
                <Hint label={verifyAffordanceLabel(verifyResult)}>
                  <Button
                    type="button"
                    onClick={() => verify.mutate(provider)}
                    disabled={verify.isPending}
                    variant="ghost"
                    size="icon-sm"
                    className={cn('hover:text-foreground shrink-0', verifyIconClassName)}
                    aria-label="Verify key"
                  >
                    {verifyBusy ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : (
                      <VerifyIcon className="size-3.5 shrink-0" />
                    )}
                  </Button>
                </Hint>
              )}
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
