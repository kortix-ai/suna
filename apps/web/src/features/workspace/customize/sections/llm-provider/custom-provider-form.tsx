'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Copy } from '@/features/icon/icons/copy';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import { upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  EyeIcon as Eye,
  EyeSlashIcon as EyeSlash,
  InfoIcon as Info,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatedCopyIcon } from '@/components/animated-copy-icon';
import { type FormEvent, type ReactNode, useState } from 'react';

import type { CustomFormState } from './types';
import { buildCustomProviderSnippet } from './utils';

/** One stacked field: label (and optional hint) above the control. */
function FormField({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field className="min-w-0 flex-1 gap-1.5">
      <FieldLabel htmlFor={htmlFor} className="text-foreground text-sm font-medium">
        {label}
      </FieldLabel>
      {children}
      {hint ? <FieldDescription className="text-xs text-pretty">{hint}</FieldDescription> : null}
    </Field>
  );
}

/** The secret name the form writes for a provider id — shown under the key field. */
export function customProviderSecretName(providerId: string): string {
  return `CUSTOM_${providerId.trim().toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

export function CustomProviderForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('customProvider');
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
  const [revealKey, setRevealKey] = useState(false);
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

      const secretName = trimmed.apiKey ? customProviderSecretName(trimmed.providerId) : null;
      if (secretName) {
        // LLM provider credentials are always project-wide (see
        // api-key-connect-form.tsx) — a per-user key is invisible to the
        // gateway's shared-row resolution and breaks every model turn.
        await upsertProjectSecret(projectId, {
          name: secretName,
          value: trimmed.apiKey,
          strategy: 'broker',
          consumer: 'llm_gateway',
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
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
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
    <div className="@container/custom-provider">
      <div className="flex flex-col gap-11 @4xl/custom-provider:flex-row @4xl/custom-provider:items-start">
        <form
          onSubmit={handleSubmit}
          className="flex w-full flex-col gap-5 @4xl/custom-provider:w-141 @4xl/custom-provider:shrink-0"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-foreground text-base font-semibold">
              {tI18nComplete.raw('text3880a3aae4e6')}
            </h2>
            <p className="text-muted-foreground text-sm text-pretty">{t('formIntro')}</p>
          </div>

          <div className="flex gap-3">
            <FormField htmlFor="custom-display-name" label={tI18nComplete.raw('text2b7f6a84de91')}>
              <Input
                id="custom-display-name"
                type="text"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder={tI18nComplete.raw('text0d41acb2175b')}
                className="font-normal"
                autoFocus
              />
            </FormField>
            <FormField htmlFor="custom-provider-id" label={tI18nComplete.raw('text7511080b05b9')}>
              <Input
                id="custom-provider-id"
                type="text"
                value={form.providerId}
                onChange={(e) =>
                  setField('providerId', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                }
                placeholder={tI18nComplete.raw('texta39b6c664e82')}
                className="font-mono font-normal"
              />
            </FormField>
          </div>

          <FormField
            htmlFor="custom-base-url"
            label={tI18nComplete.raw('text70589413a3c9')}
            hint={t('baseUrlHint')}
          >
            <Input
              id="custom-base-url"
              type="text"
              value={form.baseURL}
              onChange={(e) => setField('baseURL', e.target.value)}
              placeholder="https://api.example.com/v1"
              className="font-mono font-normal"
            />
          </FormField>

          <FormField
            htmlFor="custom-api-key"
            label={
              <span className="flex items-baseline gap-1.5">
                {tI18nComplete.raw('text16f0ee47f993')}
                <span className="text-muted-foreground text-xs font-normal">{t('optional')}</span>
              </span>
            }
          >
            <InputGroup>
              <InputGroupInput
                id="custom-api-key"
                // Masked by default, like every other credential field in this
                // app — a pasted key used to sit in plaintext on screen.
                type={revealKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                data-form-type="other"
                value={form.apiKey}
                onChange={(e) => setField('apiKey', e.target.value)}
                placeholder={tI18nComplete.raw('textb009c6c5299f')}
                className="font-mono font-normal"
              />
              {form.apiKey ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    onClick={() => setRevealKey((current) => !current)}
                    title={revealKey ? 'Hide' : 'Show'}
                    aria-label={
                      revealKey
                        ? tI18nComplete.raw('text3d0d8c59beb7')
                        : tI18nComplete.raw('textcb0b50a0d111')
                    }
                    aria-pressed={revealKey}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {revealKey ? <EyeSlash className="size-3.5" /> : <Eye className="size-3.5" />}
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            {form.providerId.trim() ? (
              <code className="text-muted-foreground font-mono text-xs break-all">
                {customProviderSecretName(form.providerId)}
              </code>
            ) : null}
          </FormField>

          <div className="flex gap-3">
            <FormField htmlFor="custom-model-id" label={tI18nComplete.raw('text089ef2b6dbb3')}>
              <Input
                id="custom-model-id"
                type="text"
                value={form.modelId}
                onChange={(e) => setField('modelId', e.target.value)}
                placeholder={tI18nComplete.raw('text34d316295094')}
                className="font-mono font-normal"
              />
            </FormField>
            <FormField htmlFor="custom-model-name" label={tI18nComplete.raw('texta3c3370cc732')}>
              <Input
                id="custom-model-name"
                type="text"
                value={form.modelName}
                onChange={(e) => setField('modelName', e.target.value)}
                placeholder={tI18nComplete.raw('textb70354a1faae')}
                className="font-normal"
              />
            </FormField>
          </div>

          {error ? (
            <InfoBanner
              tone="destructive"
              icon={TriangleAlert}
              title={tI18nComplete.raw('text464de08899db')}
            >
              {error}
            </InfoBanner>
          ) : null}

          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={save.isPending} className="gap-1.5">
              {save.isPending ? (
                <>
                  <Loading className="size-3.5 shrink-0" />
                  {tI18nComplete.raw('textd20a4476a0a8')}
                </>
              ) : (
                t('saveAndGenerate')
              )}
            </Button>
          </div>
        </form>
      </div>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { copied, copy } = useCopy({
    duration: 1500,
    successMessage: tI18nComplete.raw('texte957fd04449d'),
    errorMessage: tI18nComplete.raw('text94f69e8f103e'),
  });

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <InfoBanner
        tone="success"
        icon={Check}
        title={
          secretName ? tI18nComplete.raw('text934b6af41253') : tI18nComplete.raw('textcbddb15211ca')
        }
      >
        {secretName ? (
          <>
            {tI18nComplete.raw('text58ec60140867')}{' '}
            <code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-xs">{secretName}</code>{' '}
            {tI18nComplete.raw('textdf1db3412b9d')}
          </>
        ) : (
          tI18nComplete.raw('text4c99583a807e')
        )}
      </InfoBanner>

      <InfoBanner tone="warning" icon={Info}>
        {tI18nComplete.raw('text3915df4b6200')}
      </InfoBanner>

      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="border-border/60 flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            {tI18nComplete.raw('text82b9ffd3cec8')}{' '}
            <code className="font-mono">provider configuration</code>
          </span>
          <button
            type="button"
            onClick={() => copy(snippet)}
            aria-label={copied ? 'Copied' : tI18nComplete.raw('text968d0a9d24a6')}
            className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-[background-color,color,scale] duration-(--duration-normal) active:scale-[0.96]"
          >
            <span className="relative inline-flex size-3.5 items-center justify-center">
              <AnimatedCopyIcon copied={copied}>
                {copied ? (
                  <Check className="text-kortix-green size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </AnimatedCopyIcon>
            </span>
          </button>
        </div>
        <pre className="text-foreground max-h-[280px] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
      </div>

      <p className="text-muted-foreground px-0.5 text-xs text-pretty">
        {tI18nComplete.raw('textb81bc1d32189')}{' '}
        <code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-xs">
          provider configuration
        </code>{' '}
        {tI18nComplete.raw('textd833da5b9497')}
      </p>

      <div className="flex justify-start">
        <Button size="sm" onClick={onDone}>
          {tI18nComplete.raw('text11a6767d5674')}
        </Button>
      </div>
    </div>
  );
}
