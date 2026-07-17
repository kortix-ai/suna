'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, Info, ShieldCheck, TriangleAlert } from 'lucide-react';
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
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: provider.id });
      onConnected();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save credentials'),
  });

  const allFilled = provider.envVars.every((envVar) => values[envVar]?.trim());
  const helpHostname = useMemo(() => helpHostnameFromUrl(provider.helpUrl), [provider.helpUrl]);
  const fieldCount = provider.envVars.length;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!allFilled) {
      setError(fieldCount === 1 ? 'API key is required' : `All ${fieldCount} fields are required`);
      return;
    }
    upsert.mutate();
  }

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
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line767JsxTextBackToProviders')}
      </Button>

      {/* Provider identity — logo, name, and exactly what gets stored. */}
      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">{provider.label}</div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1 text-xs">
            <span>Stored as</span>
            {provider.envVars.map((envVar) => (
              <code
                key={envVar}
                className="bg-muted text-foreground/80 rounded px-1 py-0.5 font-mono text-[11px]"
              >
                {envVar}
              </code>
            ))}
          </div>
        </div>
      </div>

      {provider.id === 'openai' && (
        <ChatGptSubscriptionConnect projectId={projectId} onConnected={onConnected} />
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground text-sm font-medium">
              {fieldCount === 1 ? 'Credential' : 'Credentials'}
            </span>
            {fieldCount > 1 && (
              <Badge variant="outline" size="sm">
                {fieldCount} fields
              </Badge>
            )}
          </div>

          <FieldGroup className="gap-5">
            {provider.envVars.map((envVar, index) => (
              <Field key={envVar}>
                <FieldLabel htmlFor={`provider-${provider.id}-${envVar}`}>
                  {prettyFieldLabel(envVar)}
                </FieldLabel>
                <Input
                  id={`provider-${provider.id}-${envVar}`}
                  type="text"
                  value={values[envVar] ?? ''}
                  onChange={(e) =>
                    setValues((current) => ({ ...current, [envVar]: e.target.value }))
                  }
                  placeholder={envVarPlaceholder(provider, envVar)}
                  autoFocus={index === 0}
                  autoComplete="off"
                />
              </Field>
            ))}
          </FieldGroup>

          <FieldDescription className="text-xs">
            Project-wide — every member of this project can use this provider.
          </FieldDescription>

          {provider.helpUrl && helpHostname && (
            <a
              href={provider.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-xs transition-colors"
            >
              <ExternalLink className="size-3 shrink-0" />
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line827JsxTextGetCredentialsFrom',
              )}{' '}
              {helpHostname}
            </a>
          )}

          <Button
            type="submit"
            size="sm"
            className="w-full"
            disabled={upsert.isPending || !allFilled}
          >
            {upsert.isPending ? (
              <>
                <Loading className="size-3.5 shrink-0" />
                {tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line847JsxTextConnecting',
                )}
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </div>

        {error && (
          <InfoBanner tone="destructive" icon={TriangleAlert} title="Couldn't connect">
            {error}
          </InfoBanner>
        )}

        <InfoBanner tone="warning" icon={Info}>
          {tHardcodedUi.raw(
            'autoComponentsProjectsProjectProviderModalJsxTextASandboxPicks96cfb428',
          )}
        </InfoBanner>
      </form>

      <p className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
        <ShieldCheck className="size-3.5 shrink-0" />
        {tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line856JsxTextValuesAreEncryptedAtRestAes256Gcm',
        )}
      </p>
    </div>
  );
}
