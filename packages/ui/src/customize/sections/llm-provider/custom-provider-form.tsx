'use client';

import { Button } from '../../../primitives/button';
import { Field, FieldDescription, FieldLabel } from '../../../primitives/field';
import { InfoBanner } from '../../../primitives/info-banner';
import { Input } from '../../../primitives/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { Switch } from '../../../primitives/switch';
import { successToast } from '../../../primitives/toast';
import { useTranslations } from '../../../i18n';
import { type CustomLlmProvider, upsertProjectSecret } from '@kortix/sdk';
import { qk, useCustomLlmProviders } from '@kortix/sdk/react';
import {
  EyeIcon as Eye,
  EyeSlashIcon as EyeSlash,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';

import type { CustomFormState } from './types';

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

/** The API's provider id rule (`^[a-z0-9][a-z0-9_-]{0,63}$`). */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The endpoint, models and optional key of one custom provider.
 *
 * The provider is stored in Kortix (`PUT /custom-providers/:id`) and the
 * gateway serves its models; the key is the project secret
 * `CUSTOM_<ID>_API_KEY`. The PUT replaces the whole model list, so saving an
 * id that already exists keeps its other models and adds or renames this one.
 */
export function CustomProviderForm({
  projectId,
  initialId = '',
  onSaved,
}: {
  projectId: string;
  /** Pre-fills the provider id: a legacy key that has no endpoint yet. */
  initialId?: string;
  onSaved?: (providerId: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('customProvider');
  const queryClient = useQueryClient();
  const custom = useCustomLlmProviders(projectId);
  const [form, setForm] = useState<CustomFormState>({
    providerId: initialId,
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
    modelName: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const providerId = form.providerId.trim().toLowerCase();
      const name = form.name.trim();
      const baseUrl = form.baseURL.trim();
      const apiKey = form.apiKey.trim();
      const model = {
        id: form.modelId.trim(),
        name: form.modelName.trim(),
        ...(form.attachment !== undefined ? { attachment: form.attachment } : {}),
        ...(form.reasoning !== undefined ? { reasoning: form.reasoning } : {}),
      };

      if (!providerId || !name || !baseUrl) {
        throw new Error('Provider ID, name, and base URL are required');
      }
      if (!PROVIDER_ID_PATTERN.test(providerId)) {
        throw new Error('Provider ID can only use letters, numbers, dashes, underscores');
      }
      if (!/^https?:\/\//.test(baseUrl)) {
        throw new Error('Base URL must start with http:// or https://');
      }
      if (!model.id || !model.name) {
        throw new Error('At least one model (ID + name) is required');
      }
      if (/\s/.test(model.id)) {
        throw new Error('Model ID cannot contain spaces');
      }

      const existing: CustomLlmProvider | undefined = custom.providers.find(
        (p) => p.id === providerId && p.configured,
      );
      // The key first: saving the endpoint reads its `GET /models` for each model's limits.
      if (apiKey) {
        // LLM provider credentials are always project-wide (see
        // api-key-connect-form.tsx) — a per-user key is invisible to the
        // gateway's shared-row resolution and breaks every model turn.
        await upsertProjectSecret(projectId, {
          name: customProviderSecretName(providerId),
          value: apiKey,
          strategy: 'broker',
          consumer: 'llm_gateway',
        });
      }
      await custom.save(providerId, {
        name,
        base_url: baseUrl,
        models: [
          ...(existing?.models ?? [])
            .filter((m) => m.id !== model.id)
            .map(({ id, name, attachment, reasoning }) => ({ id, name, attachment, reasoning })),
          model,
        ],
      });
      return providerId;
    },
    onSuccess: (providerId) => {
      successToast(t('saved'));
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.customLlmProviders(projectId) });
      onSaved?.(providerId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('saveFailed')),
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
            <p className="text-muted-foreground text-sm text-pretty">{t('gatewayNote')}</p>
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

          <Field className="gap-2">
            <div className="text-foreground flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <label className="flex items-center gap-2">
                <Switch
                  checked={form.attachment === true}
                  onCheckedChange={(attachment) => setField('attachment', attachment)}
                />
                {t('readsImages')}
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={form.reasoning === true}
                  onCheckedChange={(reasoning) => setField('reasoning', reasoning)}
                />
                {t('reasoning')}
              </label>
            </div>
            <FieldDescription>{t('traitsHint')}</FieldDescription>
          </Field>

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
                  {t('saving')}
                </>
              ) : (
                t('saveProvider')
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
