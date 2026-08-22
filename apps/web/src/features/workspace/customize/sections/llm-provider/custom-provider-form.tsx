'use client';

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
        <p className="text-foreground px-0.5 text-sm">Add a custom provider</p>
      </div>

      <div className="flex flex-col">
        <FormRow htmlFor="custom-provider-id" label="Provider ID" hint="Lowercase, no spaces.">
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
        </FormRow>

        <FormRow htmlFor="custom-display-name" label="Display name">
          <Input
            id="custom-display-name"
            type="text"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="My LLM"
          />
        </FormRow>

        <FormRow htmlFor="custom-base-url" label="Base URL" hint="OpenAI-compatible endpoint.">
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
              API key <span className="text-muted-foreground/60">(optional)</span>
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
              placeholder="sk-… (saved as a project secret)"
              className="font-mono text-xs"
            />
            {form.apiKey ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => setRevealKey((current) => !current)}
                  title={revealKey ? 'Hide' : 'Show'}
                  aria-label={revealKey ? 'Hide the API key' : 'Show the API key'}
                  aria-pressed={revealKey}
                  className="text-muted-foreground/60 hover:text-foreground"
                >
                  {revealKey ? <EyeSlash className="size-3.5" /> : <Eye className="size-3.5" />}
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          {form.apiKey.trim() ? (
            <FieldDescription className="text-xs">
              Project-wide — every member of this project can use this provider.
            </FieldDescription>
          ) : null}
        </FormRow>

        <FormRow htmlFor="custom-model-id" label="Model ID">
          <Input
            id="custom-model-id"
            type="text"
            value={form.modelId}
            onChange={(e) => setField('modelId', e.target.value)}
            placeholder="my-llm/foo-7b"
            className="font-mono text-xs"
          />
        </FormRow>

        <FormRow htmlFor="custom-model-name" label="Model name">
          <Input
            id="custom-model-name"
            type="text"
            value={form.modelName}
            onChange={(e) => setField('modelName', e.target.value)}
            placeholder="Foo 7B"
          />
        </FormRow>
      </div>

      {error ? (
        <InfoBanner tone="destructive" icon={TriangleAlert} title="Check the fields">
          {error}
        </InfoBanner>
      ) : null}

      {/* GAP C2 — a custom provider's traffic goes straight to `baseURL`
          (see buildCustomProviderSnippet's `options.baseURL`), never through
          the Kortix gateway — so it never appears in gateway logs, never
          counts against gateway budgets, and never participates in routing
          policy/fallback. Disclosed here since nothing else in this flow
          says so. */}
      <InfoBanner tone="warning" icon={Info} title="Note">
        Requests to a custom provider go straight to its own endpoint — they don&apos;t pass through
        the Kortix gateway, so they&apos;re not covered by gateway budgets, logs, or routing.
      </InfoBanner>

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? (
            <>
              <Loading className="size-3.5 shrink-0" />
              Generating…
            </>
          ) : (
            'Generate snippet'
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
    <div className="flex flex-col gap-4">
      <InfoBanner
        tone="success"
        icon={Check}
        title={secretName ? 'API key saved' : 'Snippet ready'}
      >
        {secretName ? (
          <>
            Your key is stored as{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">{secretName}</code>{' '}
            and will be injected into sessions as an env var.
          </>
        ) : (
          'No API key was provided — the snippet below omits the apiKey field.'
        )}
      </InfoBanner>

      <InfoBanner tone="warning" icon={Info}>
        This provider talks directly to its own endpoint, bypassing the Kortix gateway — no budgets,
        logs, or routing apply to it.
      </InfoBanner>

      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="border-border/60 flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <span className="text-muted-foreground text-xs">
            Add to <code className="font-mono">.opencode/opencode.jsonc</code>
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy snippet'}
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
        Paste this into your project repo's{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
          .opencode/opencode.jsonc
        </code>{' '}
        and commit. Restart any running session for the change to land in the sandbox.
      </p>

      <div className="flex justify-end">
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
