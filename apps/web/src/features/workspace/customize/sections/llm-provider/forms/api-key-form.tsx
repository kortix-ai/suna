'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { LlmProviderEntry } from '@/lib/llm-providers';
import { upsertProjectSecret, type HarnessAuthKind, type HarnessId } from '@kortix/sdk/projects-client';
import {
  invalidateComposerCapabilityQueries,
  refreshProjectProviderState,
  type ModelsPageRuntime,
} from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ExternalLink } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';

import { envVarPlaceholder, helpHostnameFromUrl, prettyFieldLabel } from '../utils';
import { applyUseWithSelections, defaultUseWithHarnesses, UseWithRuntimes } from './use-with-runtimes';

export function ApiKeyForm({
  projectId,
  provider,
  connectionKind,
  compatibleHarnesses = [],
  runtimes,
  onBack,
  onConnected,
}: {
  projectId: string;
  provider: LlmProviderEntry;
  /** Set only for the two auth-kind-backed providers (Anthropic, OpenAI) —
   *  other catalog providers store a raw secret with no harness routing. */
  connectionKind?: HarnessAuthKind;
  compatibleHarnesses?: HarnessId[];
  runtimes: ModelsPageRuntime[];
  onBack: () => void;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.envVars.map((v) => [v, ''])),
  );
  const [useWith, setUseWith] = useState(() =>
    defaultUseWithHarnesses(compatibleHarnesses, runtimes),
  );
  const [error, setError] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: async () => {
      for (const envVar of provider.envVars) {
        await upsertProjectSecret(projectId, { name: envVar, value: values[envVar] ?? '' });
      }
      if (connectionKind) await applyUseWithSelections(projectId, connectionKind, useWith);
    },
    onSuccess: async () => {
      successToast(`${provider.label} connected`);
      await invalidateComposerCapabilityQueries(queryClient, projectId);
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
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        Back
      </Button>

      <form onSubmit={handleSubmit} className="bg-popover space-y-3 rounded-md border px-4 py-4">
        <div className="flex items-center gap-3">
          <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm font-medium">{provider.label}</div>
            <div className="text-muted-foreground mt-0.5 truncate text-xs">
              Stored as{' '}
              {provider.envVars.map((envVar, index) => (
                <span key={envVar}>
                  {index > 0 && ' · '}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">{envVar}</code>
                </span>
              ))}
            </div>
          </div>
        </div>

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
            <ExternalLink className="size-3 shrink-0" />
            Get credentials from {helpHostname}
          </a>
        )}

        {connectionKind && (
          <UseWithRuntimes
            compatible={compatibleHarnesses}
            runtimes={runtimes}
            value={useWith}
            onChange={setUseWith}
          />
        )}

        {error && (
          <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" size="sm" className="px-4" disabled={upsert.isPending || !allFilled}>
          {upsert.isPending ? <Loading className="mr-1.5 size-3.5 shrink-0" /> : null}
          Connect
        </Button>
      </form>

      <p className="text-muted-foreground px-1 text-xs">Values are encrypted at rest (AES-256-GCM).</p>
    </div>
  );
}
