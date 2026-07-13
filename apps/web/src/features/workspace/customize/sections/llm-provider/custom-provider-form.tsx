'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { refreshProjectProviderState } from '@/hooks/runtime/provider-refresh';
import { deleteProjectSecret, upsertProjectSecret } from '@kortix/sdk/projects-client';
import { invalidateComposerCapabilityQueries } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

import type { CustomFormState } from './types';

const CUSTOM_PROVIDER_SECRET_NAMES = {
  protocol: 'CUSTOM_LLM_PROTOCOL',
  baseURL: 'CUSTOM_LLM_BASE_URL',
  apiKey: 'CUSTOM_LLM_API_KEY',
  modelId: 'CUSTOM_LLM_MODEL_ID',
  name: 'CUSTOM_LLM_NAME',
} as const;

export function CustomProviderForm({
  projectId,
  onBack,
  onDone,
}: {
  projectId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomFormState>({
    protocol: 'openai',
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed: CustomFormState = {
        protocol: form.protocol,
        name: form.name.trim(),
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey.trim(),
        modelId: form.modelId.trim(),
      };

      if (!trimmed.name || !trimmed.baseURL) {
        throw new Error('Name and base URL are required');
      }
      if (!/^https?:\/\//.test(trimmed.baseURL)) {
        throw new Error('Base URL must start with http:// or https://');
      }
      if (!trimmed.modelId) {
        throw new Error('Model ID is required');
      }

      const values = [
        [CUSTOM_PROVIDER_SECRET_NAMES.protocol, trimmed.protocol],
        [CUSTOM_PROVIDER_SECRET_NAMES.baseURL, trimmed.baseURL],
        [CUSTOM_PROVIDER_SECRET_NAMES.modelId, trimmed.modelId],
        [CUSTOM_PROVIDER_SECRET_NAMES.name, trimmed.name],
        ...(trimmed.apiKey ? [[CUSTOM_PROVIDER_SECRET_NAMES.apiKey, trimmed.apiKey] as const] : []),
      ] as const;
      await Promise.all(
        values.map(([name, value]) => upsertProjectSecret(projectId, { name, value })),
      );
      if (!trimmed.apiKey) {
        await deleteProjectSecret(projectId, CUSTOM_PROVIDER_SECRET_NAMES.apiKey).catch(
          () => undefined,
        );
      }
    },
    onSuccess: () => {
      void invalidateComposerCapabilityQueries(queryClient, projectId);
      refreshProjectProviderState(queryClient, projectId);
      successToast('Custom provider connected');
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  function setField<K extends keyof CustomFormState>(key: K, value: CustomFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (error) setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    save.mutate();
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
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line983JsxTextBackToProviders')}
      </Button>

      <div className="border-border/50 bg-muted/20 rounded-2xl border px-3.5 py-3">
        <div className="text-foreground text-sm font-medium">
          {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line987JsxTextCustomProvider')}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Connect a REST endpoint once. Kortix translates it into native configuration for every
          compatible ACP harness.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-border/50 bg-muted/20 space-y-3 rounded-2xl border p-4"
      >
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            API compatibility
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(['openai', 'anthropic'] as const).map((protocol) => (
              <Button
                key={protocol}
                type="button"
                size="sm"
                variant={form.protocol === protocol ? 'secondary' : 'outline'}
                onClick={() => setField('protocol', protocol)}
              >
                {protocol === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible'}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs text-pretty">
            {form.protocol === 'openai'
              ? 'Available to Codex, OpenCode, and Pi.'
              : 'Available to Claude Code. The endpoint must implement the Anthropic Messages API.'}
          </p>
        </div>
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1020JsxTextDisplayName')}
          </label>
          <Input
            type="text"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder={tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line1026JsxAttrPlaceholderMyLlm',
            )}
            className="h-9 text-sm"
            autoFocus
          />
        </div>

        {form.apiKey.trim() && (
          <p className="text-muted-foreground text-xs">
            Project-wide — every member of this project can use this provider.
          </p>
        )}
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1033JsxTextBaseUrl')}
          </label>
          <Input
            type="text"
            value={form.baseURL}
            onChange={(e) => setField('baseURL', e.target.value)}
            placeholder="https://api.example.com/v1"
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1045JsxTextApiKey')}{' '}
            <span className="text-muted-foreground/60 font-normal">(optional)</span>
          </label>
          <Input
            type="text"
            value={form.apiKey}
            onChange={(e) => setField('apiKey', e.target.value)}
            placeholder={tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line1052JsxAttrPlaceholderSkSavedAsAProjectSecret',
            )}
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1059JsxTextModelId')}
          </label>
          <Input
            type="text"
            value={form.modelId}
            onChange={(e) => setField('modelId', e.target.value)}
            placeholder="my-llm/foo-7b"
            className="h-9 font-mono text-xs"
          />
        </div>

        {error && (
          <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-2xl px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" size="sm" className="px-4" disabled={save.isPending}>
          {save.isPending ? (
            <>
              <Loading className="mr-1.5 size-3.5 shrink-0" />
              Connecting…
            </>
          ) : (
            'Connect provider'
          )}
        </Button>
      </form>
    </div>
  );
}
