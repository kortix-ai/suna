'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The add-a-custom-provider form, as rows on the API-keys list's own axis.
 *
 * It used to be a `bg-popover` card of six fields in two `sm:grid-cols-2`
 * pairs, so the inputs sat at four different x-positions and the screen read
 * as a different product from the provider list one tab over. Here every field
 * is one row — label left, input right — on the same
 * `minmax(0,13rem)_minmax(0,1fr)` grid `provider-connect.tsx` uses, so the
 * whole tab is scanned by running the eye down one column.
 *
 * The submit, the validation, the secret write and the generated snippet are
 * unchanged; this is the same mutation with different markup. Two real fixes
 * came along with it:
 *
 *  - The API key field was `type="text"` — a pasted key sat legible on screen
 *    and in every screenshot. It is now masked with a reveal button and the
 *    three password-manager opt-outs, exactly like a provider key field.
 *  - `onBack` was destructured and never rendered anywhere, so the prop was a
 *    promise of a control that did not exist. Removed.
 */

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
import { errorToast, successToast } from '@/components/ui/toast';
import { upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  EyeIcon as Eye,
  EyeSlashIcon as EyeSlash,
  InfoIcon as Info,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';

import type { CustomFormState } from './types';
import { buildCustomProviderSnippet } from './utils';

/** One field, on the provider list's two-column axis. */
function FormRow({
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
    <div className="grid gap-1.5 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <FieldLabel htmlFor={htmlFor} className="text-foreground text-sm font-normal">
          {label}
        </FieldLabel>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{hint}</p> : null}
      </div>
      <Field className="min-w-0">{children}</Field>
    </div>
  );
}

export function CustomProviderForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="border-border/60 border-t pt-4">
        <p className="text-foreground px-0.5 text-sm">{tI18nComplete.raw('text3880a3aae4e6')}</p>
      </div>

      <div className="flex flex-col">
        <FormRow
          htmlFor="custom-provider-id"
          label={tI18nComplete.raw('text7511080b05b9')}
          hint={tI18nComplete.raw('text740493750bb7')}
        >
          <Input
            id="custom-provider-id"
            type="text"
            value={form.providerId}
            onChange={(e) =>
              setField('providerId', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
            }
            placeholder={tI18nComplete.raw('texta39b6c664e82')}
            className="font-mono text-xs"
            autoFocus
          />
        </FormRow>

        <FormRow htmlFor="custom-display-name" label={tI18nComplete.raw('text2b7f6a84de91')}>
          <Input
            id="custom-display-name"
            type="text"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder={tI18nComplete.raw('text0d41acb2175b')}
          />
        </FormRow>

        <FormRow
          htmlFor="custom-base-url"
          label={tI18nComplete.raw('text70589413a3c9')}
          hint={tI18nComplete.raw('texte4273a188eb5')}
        >
          <Input
            id="custom-base-url"
            type="text"
            value={form.baseURL}
            onChange={(e) => setField('baseURL', e.target.value)}
            placeholder="https://api.example.com/v1"
            className="font-mono text-xs"
          />
        </FormRow>

        <FormRow
          htmlFor="custom-api-key"
          label={
            <>
              {tI18nComplete.raw('text16f0ee47f993')}{' '}
              <span className="text-muted-foreground">{tI18nComplete.raw('text0059798b7f70')}</span>
            </>
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
              className="font-mono text-xs"
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
          {form.apiKey.trim() ? (
            <FieldDescription className="text-xs">
              {tI18nComplete.raw('text6bf9ada8447c')}
            </FieldDescription>
          ) : null}
        </FormRow>

        <FormRow htmlFor="custom-model-id" label={tI18nComplete.raw('text089ef2b6dbb3')}>
          <Input
            id="custom-model-id"
            type="text"
            value={form.modelId}
            onChange={(e) => setField('modelId', e.target.value)}
            placeholder={tI18nComplete.raw('text34d316295094')}
            className="font-mono text-xs"
          />
        </FormRow>

        <FormRow htmlFor="custom-model-name" label={tI18nComplete.raw('texta3c3370cc732')}>
          <Input
            id="custom-model-name"
            type="text"
            value={form.modelName}
            onChange={(e) => setField('modelName', e.target.value)}
            placeholder={tI18nComplete.raw('textb70354a1faae')}
          />
        </FormRow>
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

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? (
            <>
              <Loading className="size-3.5 shrink-0" />
              {tI18nComplete.raw('textd20a4476a0a8')}
            </>
          ) : (
            tI18nComplete.raw('text3dc8d68addcd')
          )}
        </Button>
      </div>
    </form>
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
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      successToast(tI18nComplete.raw('texte957fd04449d'));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      errorToast(tI18nComplete.raw('text94f69e8f103e'));
    }
  }

  return (
    <div className="flex flex-col gap-4">
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
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{secretName}</code>{' '}
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
            <code className="font-mono">.opencode/opencode.jsonc</code>
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : tI18nComplete.raw('text968d0a9d24a6')}
            className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors active:scale-[0.97]"
          >
            <span className="relative inline-flex size-3.5 items-center justify-center">
              <AnimatePresence initial={false} mode="popLayout">
                <m.span
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
                </m.span>
              </AnimatePresence>
            </span>
          </button>
        </div>
        <pre className="text-foreground max-h-[280px] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
      </div>

      <p className="text-muted-foreground px-0.5 text-xs text-pretty">
        {tI18nComplete.raw('textb81bc1d32189')}{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
          .opencode/opencode.jsonc
        </code>{' '}
        {tI18nComplete.raw('textd833da5b9497')}
      </p>

      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>
          {tI18nComplete.raw('text11a6767d5674')}
        </Button>
      </div>
    </div>
  );
}
