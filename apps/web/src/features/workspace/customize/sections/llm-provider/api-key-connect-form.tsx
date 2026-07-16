'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { setPersonalProjectSecret, upsertProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ExternalLink, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useMemo, useState } from 'react';

import { ChatGptSubscriptionConnect } from './chatgpt-subscription-connect';
import { DEFAULT_SECRET_VISIBILITY, SECRET_VISIBILITY_COPY } from './constants';
import { envVarPlaceholder, helpHostnameFromUrl, prettyFieldLabel } from './utils';

// LLM provider credentials default to SHARED (project-wide) — every session in
// the workspace can use them. A key saved PRIVATE (only me) is invisible to
// every OTHER member's session; the gateway falls back to it ONLY for the
// saving member's own sessions (getResolvedProjectSecretValue), never anyone
// else's. Before that fallback existed, a private key here just silently died
// with "No upstream configured" while the picker still showed it as connected
// (2026-07-07 prod incident, recurred on self-host deployments carrying
// pre-existing private rows) — this toggle now defaults to Shared specifically
// so nobody has to discover that distinction the hard way. Default + copy live
// in constants.ts (unit-tested there) so the two never drift apart.

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
  // Defaults to shared — see the file-level comment on why.
  const [visibility, setVisibility] = useState(DEFAULT_SECRET_VISIBILITY);

  const upsert = useMutation({
    mutationFn: async () => {
      for (const envVar of provider.envVars) {
        if (visibility === 'private') {
          await setPersonalProjectSecret(projectId, envVar, {
            value: values[envVar] ?? '',
            active: true,
          });
        } else {
          await upsertProjectSecret(projectId, {
            name: envVar,
            value: values[envVar] ?? '',
          });
        }
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

        <div
          role="radiogroup"
          aria-label="Who can use this key"
          className="border-border/50 grid grid-cols-2 gap-2 rounded-xl border p-1"
        >
          {(Object.entries(SECRET_VISIBILITY_COPY) as Array<
            [keyof typeof SECRET_VISIBILITY_COPY, (typeof SECRET_VISIBILITY_COPY)[keyof typeof SECRET_VISIBILITY_COPY]]
          >).map(([option, copy]) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={visibility === option}
              onClick={() => setVisibility(option)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                visibility === option
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="block font-medium">{copy.label}</span>
              <span className="text-muted-foreground block text-[11px]">{copy.description}</span>
            </button>
          ))}
        </div>

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

        <InfoBanner tone="warning" icon={Info} className="rounded-2xl">
          {tHardcodedUi.raw(
            'autoComponentsProjectsProjectProviderModalJsxTextASandboxPicks96cfb428',
          )}
        </InfoBanner>

        <Button type="submit" size="sm" className="px-4" disabled={upsert.isPending || !allFilled}>
          {upsert.isPending ? (
            <>
              <Loading className="mr-1.5 size-3.5 shrink-0" />
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
