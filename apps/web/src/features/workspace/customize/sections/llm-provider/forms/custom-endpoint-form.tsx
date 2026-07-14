'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { deleteProjectSecret, upsertProjectSecret, type HarnessId } from '@kortix/sdk/projects-client';
import {
  invalidateComposerCapabilityQueries,
  refreshProjectProviderState,
  type ModelsPageRuntime,
} from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';

import type { CustomFormState } from '../types';
import { applyUseWithSelections, defaultUseWithHarnesses, UseWithRuntimes } from './use-with-runtimes';

const CUSTOM_PROVIDER_SECRET_NAMES = {
  protocol: 'CUSTOM_LLM_PROTOCOL',
  baseURL: 'CUSTOM_LLM_BASE_URL',
  apiKey: 'CUSTOM_LLM_API_KEY',
  modelId: 'CUSTOM_LLM_MODEL_ID',
  name: 'CUSTOM_LLM_NAME',
} as const;

const COMPATIBLE_HARNESSES: Record<CustomFormState['protocol'], HarnessId[]> = {
  openai: ['codex', 'opencode', 'pi'],
  anthropic: ['claude'],
};

export function CustomEndpointForm({
  projectId,
  runtimes,
  initialProtocol = 'openai',
  onBack,
  onDone,
}: {
  projectId: string;
  runtimes: ModelsPageRuntime[];
  initialProtocol?: CustomFormState['protocol'];
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomFormState>({
    protocol: initialProtocol,
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
  });
  const [error, setError] = useState<string | null>(null);
  const compatibleHarnesses = COMPATIBLE_HARNESSES[form.protocol];
  const [useWith, setUseWith] = useState(() => defaultUseWithHarnesses(compatibleHarnesses, runtimes));

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
      const kind = trimmed.protocol === 'openai' ? 'openai_compatible' : 'anthropic_compatible';
      await applyUseWithSelections(projectId, kind, useWith);
    },
    onSuccess: async () => {
      await invalidateComposerCapabilityQueries(queryClient, projectId);
      refreshProjectProviderState(queryClient, projectId);
      successToast('Custom endpoint connected');
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  function setField<K extends keyof CustomFormState>(key: K, value: CustomFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (error) setError(null);
  }

  function setProtocol(protocol: CustomFormState['protocol']) {
    setForm((current) => ({ ...current, protocol }));
    setUseWith(defaultUseWithHarnesses(COMPATIBLE_HARNESSES[protocol], runtimes));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    save.mutate();
  }

  const protocolHint = useMemo(
    () =>
      form.protocol === 'openai'
        ? 'Available to Codex, OpenCode, and Pi.'
        : 'Available to Claude Code. The endpoint must implement the Anthropic Messages API.',
    [form.protocol],
  );

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

      <div className="bg-popover rounded-md border px-4 py-3">
        <div className="text-foreground text-sm font-medium">Custom endpoint</div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Connect a REST endpoint once. Kortix translates it into native configuration for every
          compatible ACP harness.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-popover space-y-3 rounded-md border px-4 py-4">
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
                onClick={() => setProtocol(protocol)}
              >
                {protocol === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible'}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs text-pretty">{protocolHint}</p>
        </div>
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
            Display name
          </label>
          <Input
            type="text"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="My LLM"
            className="h-9 text-sm"
            autoFocus
          />
        </div>

        {form.apiKey.trim() && (
          <p className="text-muted-foreground text-xs">
            Project-wide — every member of this project can use this endpoint.
          </p>
        )}
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">Base URL</label>
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
            API key <span className="text-muted-foreground/60 font-normal">(optional)</span>
          </label>
          <Input
            type="text"
            value={form.apiKey}
            onChange={(e) => setField('apiKey', e.target.value)}
            placeholder="sk-… — saved as a project secret"
            className="h-9 font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-muted-foreground mb-1.5 block text-xs font-medium">Model ID</label>
          <Input
            type="text"
            value={form.modelId}
            onChange={(e) => setField('modelId', e.target.value)}
            placeholder="my-llm/foo-7b"
            className="h-9 font-mono text-xs"
          />
        </div>

        <UseWithRuntimes
          compatible={compatibleHarnesses}
          runtimes={runtimes}
          value={useWith}
          onChange={setUseWith}
        />

        {error && (
          <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" size="sm" className="px-4" disabled={save.isPending}>
          {save.isPending ? <Loading className="mr-1.5 size-3.5 shrink-0" /> : null}
          Connect endpoint
        </Button>
      </form>
    </div>
  );
}
