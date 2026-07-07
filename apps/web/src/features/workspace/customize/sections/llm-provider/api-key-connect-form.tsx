'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ExternalLink, Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useMemo, useState } from 'react';

import { ChatGptSubscriptionConnect } from './chatgpt-subscription-connect';
import { envVarPlaceholder, helpHostnameFromUrl, prettyFieldLabel } from './utils';

// LLM provider credentials are ALWAYS project-wide. A per-user "Only me" key is
// invisible to the LLM gateway's shared-row resolution, so every model turn
// dies with "No upstream configured" while the picker still shows the provider
// as connected (2026-07-07 prod incident). The server rejects personal
// overrides for provider env vars; this form never offers the choice.

export function ApiKeyConnectForm({
  projectId,
  provider,
  onBack,
  onConnected,
}: {
  projectId: string;
  provider: LlmProviderEntry;
  onBack: () => void;
  onConnected: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.envVars.map((v) => [v, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: async () => {
      for (const envVar of provider.envVars) {
        await upsertProjectSecret(projectId, {
          name: envVar,
          value: values[envVar] ?? '',
        });
      }
    },
    onSuccess: () => {
      successToast(`${provider.label} connected`);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      refreshProjectProviderState(queryClient, projectId);
      onConnected();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save credentials'),
  });

  const allFilled = provider.envVars.every((envVar) => values[envVar]?.trim());
  const helpHostname = useMemo(() => helpHostnameFromUrl(provider.helpUrl), [provider.helpUrl]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!allFilled) {
      setError(
        provider.envVars.length === 1
          ? 'API key is required'
          : `All ${provider.envVars.length} fields are required`,
      );
      return;
    }
    upsert.mutate();
  }

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
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line767JsxTextBackToProviders')}
      </Button>

      <div className="border-border/50 bg-muted/20 flex items-center gap-3 rounded-2xl border px-3.5 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">{provider.label}</div>
          <div className="text-muted-foreground mt-0.5 truncate text-xs">
            Stored as{' '}
            {provider.envVars.map((envVar, index) => (
              <span key={envVar}>
                {index > 0 && ' · '}
                <code className="bg-background rounded px-1 py-0.5 font-mono">{envVar}</code>
              </span>
            ))}
          </div>
        </div>
      </div>

      {provider.id === 'openai' && (
        <ChatGptSubscriptionConnect projectId={projectId} onConnected={onConnected} />
      )}

      <form
        onSubmit={handleSubmit}
        className={cn('border-border/50 bg-muted/20 space-y-3 rounded-2xl border p-4')}
      >
        {provider.envVars.map((envVar, index) => (
          <div key={envVar}>
            <label
              htmlFor={`provider-${provider.id}-${envVar}`}
              className="text-muted-foreground mb-1.5 block text-xs font-medium"
            >
              {prettyFieldLabel(envVar)}
            </label>
            <Input
              id={`provider-${provider.id}-${envVar}`}
              type="text"
              value={values[envVar] ?? ''}
              onChange={(e) => setValues((current) => ({ ...current, [envVar]: e.target.value }))}
              placeholder={envVarPlaceholder(provider, envVar)}
              className="h-9 text-sm"
              autoFocus={index === 0}
              autoComplete="off"
            />
          </div>
        ))}

        <p className="text-muted-foreground text-xs">
          Project-wide — every member of this project can use this provider.
        </p>

        {provider.helpUrl && helpHostname && (
          <a
            href={provider.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs"
          >
            <ExternalLink className="h-3 w-3" />
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line827JsxTextGetCredentialsFrom',
            )}{' '}
            {helpHostname}
          </a>
        )}

        {error && (
          <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-2xl px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
          <p className="text-foreground/80 text-xs leading-relaxed">
            {tHardcodedUi.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextASandboxPicks96cfb428',
            )}
          </p>
        </div>

        <Button type="submit" size="sm" className="px-4" disabled={upsert.isPending || !allFilled}>
          {upsert.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line847JsxTextConnecting')}
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </form>

      <p className="text-muted-foreground px-1 text-xs">
        {tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line856JsxTextValuesAreEncryptedAtRestAes256Gcm',
        )}
      </p>
    </div>
  );
}
