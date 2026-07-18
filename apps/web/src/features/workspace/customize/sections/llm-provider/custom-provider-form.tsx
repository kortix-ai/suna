'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { refreshProjectProviderState } from '@/hooks/opencode/provider-refresh';
import { upsertProjectSecret } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Copy, Info, Plus, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

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
        // LLM provider credentials are always project-wide (see
        // api-key-connect-form.tsx) — a per-user key is invisible to the
        // gateway's shared-row resolution and breaks every model turn.
        await upsertProjectSecret(projectId, {
          name: secretName,
          value: trimmed.apiKey,
        });
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
      refreshProjectProviderState(queryClient, projectId);
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
    <div className="space-y-4 px-5 pt-3 pb-5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line983JsxTextBackToProviders')}
      </Button>

      <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
        <span className="border-border/60 text-muted-foreground/70 flex size-9 shrink-0 items-center justify-center rounded-sm border border-dashed">
          <Plus className="size-4 shrink-0" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line987JsxTextCustomProvider',
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line989JsxTextConnectAnyOpenaiCompatibleEndpointTheApiKey',
            )}{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
              .opencode/opencode.jsonc
            </code>
            .
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
          <FieldGroup className="gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="custom-provider-id">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1002JsxTextProviderId',
                  )}
                </FieldLabel>
                <Input
                  id="custom-provider-id"
                  type="text"
                  value={form.providerId}
                  onChange={(e) =>
                    setField('providerId', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                  }
                  placeholder="my-llm"
                  className="font-mono text-xs"
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-display-name">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1020JsxTextDisplayName',
                  )}
                </FieldLabel>
                <Input
                  id="custom-display-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1026JsxAttrPlaceholderMyLlm',
                  )}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="custom-base-url">
                {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1033JsxTextBaseUrl')}
              </FieldLabel>
              <Input
                id="custom-base-url"
                type="text"
                value={form.baseURL}
                onChange={(e) => setField('baseURL', e.target.value)}
                placeholder="https://api.example.com/v1"
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="custom-api-key">
                {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1045JsxTextApiKey')}{' '}
                <span className="text-muted-foreground/60 font-normal">(optional)</span>
              </FieldLabel>
              <Input
                id="custom-api-key"
                type="text"
                value={form.apiKey}
                onChange={(e) => setField('apiKey', e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line1052JsxAttrPlaceholderSkSavedAsAProjectSecret',
                )}
                className="font-mono text-xs"
              />
              {form.apiKey.trim() && (
                <FieldDescription className="text-xs">
                  Project-wide — every member of this project can use this provider.
                </FieldDescription>
              )}
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="custom-model-id">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1059JsxTextModelId',
                  )}
                </FieldLabel>
                <Input
                  id="custom-model-id"
                  type="text"
                  value={form.modelId}
                  onChange={(e) => setField('modelId', e.target.value)}
                  placeholder="my-llm/foo-7b"
                  className="font-mono text-xs"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-model-name">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1071JsxTextModelName',
                  )}
                </FieldLabel>
                <Input
                  id="custom-model-name"
                  type="text"
                  value={form.modelName}
                  onChange={(e) => setField('modelName', e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line1077JsxAttrPlaceholderFoo7b',
                  )}
                />
              </Field>
            </div>
          </FieldGroup>

          <Button type="submit" size="sm" className="w-full" disabled={save.isPending}>
            {save.isPending ? (
              <>
                <Loading className="size-3.5 shrink-0" />
                {tHardcodedUi.raw(
                  'componentsProjectsProjectProviderModal.line1094JsxTextGenerating',
                )}
              </>
            ) : (
              'Generate snippet'
            )}
          </Button>
        </div>

        {error && (
          <InfoBanner tone="destructive" icon={TriangleAlert} title="Check the fields">
            {error}
          </InfoBanner>
        )}

        {/* GAP C2 — a custom provider's traffic goes straight to `baseURL`
            (see buildCustomProviderSnippet's `options.baseURL`), never through
            the Kortix gateway — so it never appears in gateway logs, never
            counts against gateway budgets, and never participates in routing
            policy/fallback. Disclosed here since nothing else in this flow
            says so. */}
        <InfoBanner tone="warning" icon={Info}>
          Requests to a custom provider go straight to its own endpoint — they don&apos;t pass
          through the Kortix gateway, so they&apos;re not covered by gateway budgets, logs, or
          routing.
        </InfoBanner>
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
    <div className="space-y-4 px-5 pt-3 pb-5">
      <InfoBanner
        tone="success"
        icon={Check}
        title={secretName ? 'API key saved' : 'Snippet ready'}
      >
        {secretName ? (
          <>
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line1136JsxTextYourKeyIsStoredAs',
            )}{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">{secretName}</code>{' '}
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line1138JsxTextAndWillBeInjectedIntoSessionsAsAn',
            )}
          </>
        ) : (
          tHardcodedUi.raw(
            'componentsProjectsProjectProviderModal.line1141JsxTextNoApiKeyWasProvidedTheSnippetBelow',
          )
        )}
      </InfoBanner>

      <InfoBanner tone="warning" icon={Info}>
        This provider talks directly to its own endpoint, bypassing the Kortix gateway — no budgets,
        logs, or routing apply to it.
      </InfoBanner>

      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="border-border/60 flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line1149JsxTextAddTo')}
            <code className="font-mono">.opencode/opencode.jsonc</code>
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy snippet'}
            className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors active:scale-[0.97]"
          >
            <span className="relative inline-flex size-3.5 items-center justify-center">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? 'check' : 'copy'}
                  initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                  exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="absolute inset-0 inline-flex items-center justify-center"
                >
                  {copied ? (
                    <Check className="text-kortix-green size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </button>
        </div>
        <pre className="text-foreground max-h-[280px] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
      </div>

      <p className="text-muted-foreground px-1 text-xs text-pretty">
        {tHardcodedUi.raw(
          'componentsProjectsProjectProviderModal.line1168JsxTextPasteThisIntoYourProjectRepoAposS',
        )}{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          .opencode/opencode.jsonc
        </code>{' '}
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
