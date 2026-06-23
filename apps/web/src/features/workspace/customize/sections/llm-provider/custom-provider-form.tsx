'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  SharingPicker,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/features/workspace/shared/sharing-picker';
import {
  setPersonalProjectSecret,
  upsertProjectSecret,
} from '@/lib/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, Copy, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FormEvent, useState } from 'react';

import type { CustomFormState } from './types';
import { buildCustomProviderSnippet } from './utils';

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
    providerId: '',
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
    modelName: '',
  });
  const [sharing, setSharing] = useState<SharingSelection>({
    mode: 'project',
    memberIds: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [savedSnippet, setSavedSnippet] = useState<{
    snippet: string;
    secretName: string | null;
  } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed: CustomFormState = {
        providerId: form.providerId.trim().toLowerCase(),
        name: form.name.trim(),
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey.trim(),
        modelId: form.modelId.trim(),
        modelName: form.modelName.trim(),
      };

      if (!trimmed.providerId || !trimmed.name || !trimmed.baseURL) {
        throw new Error('Provider ID, name, and base URL are required');
      }
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed.providerId)) {
        throw new Error('Provider ID can only use letters, numbers, dashes, underscores');
      }
      if (!/^https?:\/\//.test(trimmed.baseURL)) {
        throw new Error('Base URL must start with http:// or https://');
      }
      if (!trimmed.modelId || !trimmed.modelName) {
        throw new Error('At least one model (ID + name) is required');
      }

      const secretName = trimmed.apiKey
        ? `CUSTOM_${trimmed.providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`
        : null;
      if (secretName) {
        if (!isSharingComplete(sharing)) {
          throw new Error('Pick at least one member, or choose another access option.');
        }
        if (sharing.mode === 'private') {
          await setPersonalProjectSecret(projectId, secretName, {
            value: trimmed.apiKey,
            active: true,
          });
        } else {
          await upsertProjectSecret(projectId, {
            name: secretName,
            value: trimmed.apiKey,
            sharing: selectionToIntent(sharing),
          });
        }
      }

      const snippet = buildCustomProviderSnippet({
        providerId: trimmed.providerId,
        name: trimmed.name,
        baseURL: trimmed.baseURL,
        secretName,
        modelId: trimmed.modelId,
        modelName: trimmed.modelName,
      });

      return { snippet, secretName };
    },
    onSuccess: (result) => {
      setSavedSnippet(result);
      queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
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

  if (savedSnippet) {
    return (
      <CustomProviderSnippetView
        snippet={savedSnippet.snippet}
        secretName={savedSnippet.secretName}
        onDone={onDone}
      />
    );
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
          {tHardcodedUi.raw(
            'componentsProjectsProjectProviderModal.line989JsxTextConnectAnyOpenaiCompatibleEndpointTheApiKey',
          )}{' '}
          <code className="bg-background rounded px-1 py-0.5 font-mono">
            .opencode/opencode.jsonc
          </code>
          .
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-border/50 bg-muted/20 space-y-3 rounded-2xl border p-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1002JsxTextProviderId')}
            </label>
            <Input
              type="text"
              value={form.providerId}
              onChange={(e) =>
                setField('providerId', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
              }
              placeholder="my-llm"
              className="h-9 font-mono text-xs"
              autoFocus
            />
          </div>
          <div>
            <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line1020JsxTextDisplayName',
              )}
            </label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder={tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line1026JsxAttrPlaceholderMyLlm',
              )}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {form.apiKey.trim() && (
          <SharingPicker projectId={projectId} value={sharing} onChange={setSharing} showHeading />
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
        <div className="grid grid-cols-2 gap-3">
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
          <div>
            <label className="text-muted-foreground mb-1.5 block text-xs font-medium">
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1071JsxTextModelName')}
            </label>
            <Input
              type="text"
              value={form.modelName}
              onChange={(e) => setField('modelName', e.target.value)}
              placeholder={tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line1077JsxAttrPlaceholderFoo7b',
              )}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-2xl px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          type="submit"
          size="sm"
          className="px-4"
          disabled={save.isPending || (Boolean(form.apiKey.trim()) && !isSharingComplete(sharing))}
        >
          {save.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1094JsxTextGenerating')}
            </>
          ) : (
            'Generate snippet'
          )}
        </Button>
      </form>
    </div>
  );
}

function CustomProviderSnippetView({
  snippet,
  secretName,
  onDone,
}: {
  snippet: string;
  secretName: string | null;
  onDone: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      successToast('Snippet copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      errorToast('Copy failed — select and copy manually');
    }
  }

  return (
    <div className="space-y-3 px-5 pt-3 pb-5">
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.04] px-3.5 py-3">
        <div className="text-foreground text-sm font-medium">
          {secretName ? 'API key saved' : 'Snippet ready'}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {secretName ? (
            <>
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line1136JsxTextYourKeyIsStoredAs',
              )}{' '}
              <code className="bg-background rounded px-1 py-0.5 font-mono">{secretName}</code>{' '}
              {tHardcodedUi.raw(
                'componentsProjectsProjectProviderModal.line1138JsxTextAndWillBeInjectedIntoSessionsAsAn',
              )}
            </>
          ) : (
            tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line1141JsxTextNoApiKeyWasProvidedTheSnippetBelow',
            )
          )}
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-muted-foreground/60 text-xs font-medium tracking-wide uppercase">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1149JsxTextAddTo')}
            <code className="font-mono normal-case">.opencode/opencode.jsonc</code>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={handleCopy}
          >
            <Copy className="h-3 w-3" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="border-border/40 bg-muted/20 text-foreground max-h-[280px] overflow-auto rounded-2xl border px-3 py-2.5 font-mono text-xs leading-snug">
          {snippet}
        </pre>
      </div>

      <p className="text-muted-foreground px-1 text-xs">
        {tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line1168JsxTextPasteThisIntoYourProjectRepoAposS',
        )}{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono">.opencode/opencode.jsonc</code>{' '}
        {tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line1170JsxTextAndCommitRestartAnyRunningSessionForThe',
        )}
      </p>

      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
