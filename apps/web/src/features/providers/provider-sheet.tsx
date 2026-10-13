'use client';

/**
 * `provider-sheet.tsx` — one provider, opened from the Providers list
 * (`provider-connect.tsx`) into the host's `SplitSheet`: the Models page and
 * the quick provider dialog both render it.
 *
 * What the sheet shows depends on how the provider connects:
 *
 *  - **Kortix** — included with the plan. No key; the models it serves.
 *  - **An API-key provider** — the saved key with Replace, or the key form
 *    with an explicit Save. One field per env var, in one bordered box when a
 *    provider needs several (Bedrock's id / secret / region).
 *  - **OpenAI and OpenCode Go** — two ways in. With nothing connected the sheet
 *    asks which: a subscription sign-in (device code) or an API key. With
 *    either connected it lists the connections and offers the other.
 *  - **Pooled keys** (`pooled_provider_secrets`) — the account-level key
 *    manager, as before.
 *
 * Saving is a button, not a blur. The old list saved a field when focus left
 * its row, so a key went to the server with nothing on screen to say so.
 *
 * The pieces under `// ─── View` are pure (props only) so they render under
 * `renderToStaticMarkup`; `ProviderSheet` owns every hook.
 */

import { ArrowSquareOutIcon, PlugsIcon as Unplug } from '@phosphor-icons/react';
import { type FormEvent, type ReactNode, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { Switch } from '@/components/ui/switch';
import { Copy } from '@/features/icon/icons/copy';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  SplitSheetBody,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  ProviderLogoStatus,
  connectedVia,
  providerMethod,
  type ProviderStatus,
  supportsPooledProviderKey,
  useManagedProvider,
  usePooledProviderIds,
  useProviderMeta,
} from '@/features/providers/provider-connect';
import {
  ChatGptSubscriptionConnect,
  type SubscriptionKind,
  useSubscriptionSignIn,
} from '@/features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  envVarPlaceholder,
  formatTokenCount,
  prettyFieldLabel,
  providerDisconnectPlan,
} from '@/features/workspace/customize/sections/llm-provider/utils';
import { AccountSecretResourcesPanel } from '@/features/workspace/customize/sections/view/account-secret-resources-panel';
import { useTranslations } from '@/i18n/use-translations';
import { LLM_PROVIDER_BY_ID, type LlmProviderEntry, type LlmProviderModel } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { deleteProjectProviderOAuth, deleteProjectSecret, upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState, useModelAccess } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/** The subscription each two-way provider signs in with, and how it is named. */
export const SUBSCRIPTION_BY_PROVIDER: Record<string, { kind: SubscriptionKind; name: string; plan: string }> = {
  openai: { kind: 'chatgpt', name: 'ChatGPT', plan: 'ChatGPT Plus or Pro' },
  'opencode-go': { kind: 'opencode-go', name: 'OpenCode', plan: 'OpenCode Go' },
};


/** Stable DOM id shared by a credential input and its label. */
export function providerKeyFieldId(providerId: string, envVar: string): string {
  return `provider-key-${providerId}-${envVar}`;
}

// ─── View ────────────────────────────────────────────────────────────────────

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Every model a provider serves. */
export function ProviderModelsList({
  models,
  connected,
}: {
  models: readonly LlmProviderModel[];
  connected: boolean;
}) {
  const t = useTranslations('providerSheet');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (models.length === 0) return null;
  return (
    <Section title={connected ? t('models', { count: models.length }) : t('whatUnlocks')}>
      <ul className="divide-border divide-y">
        {models.map((model) => {
          const ctx = formatTokenCount(model.limit?.context);
          return (
            <li key={model.id} className="flex min-h-10 items-center justify-between gap-3 py-2">
              <span
                className={cn(
                  'min-w-0 truncate text-sm',
                  connected ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {model.name}
              </span>
              {ctx ? (
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {ctx} {tI18nComplete.raw('text0230c6b1d833')}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Turn a provider's inference on or off for this project. Credentials stay
 * either way. The project default's provider cannot be turned off until the
 * default moves elsewhere.
 */
export function ProviderAccessRow({
  name,
  enabled,
  isDefault,
  pending,
  canWrite,
  onChange,
}: {
  name: string;
  enabled: boolean;
  isDefault: boolean;
  pending: boolean;
  canWrite: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const tAccess = useTranslations('modelAccess');
  const locked = isDefault && enabled;
  const id = `provider-access-${name}`;
  return (
    <div className="flex items-start justify-between gap-4" data-provider-access-row="">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="text-foreground block text-sm font-medium">
          {tAccess('enableProvider', { name })}
        </label>
        <p className="text-muted-foreground text-xs text-pretty">
          {locked ? tAccess('defaultProviderHint') : tAccess('credentialsHint')}
        </p>
      </div>
      <Switch
        id={id}
        checked={enabled}
        disabled={!canWrite || pending || locked}
        onCheckedChange={onChange}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

export interface ProviderKeyFormProps {
  entry: Pick<LlmProviderEntry, 'id' | 'label' | 'envVars' | 'helpUrl'> & Partial<LlmProviderEntry>;
  values: Record<string, string>;
  onValueChange: (envVar: string, value: string) => void;
  onSave: () => void;
  onCancel?: () => void;
  saving: boolean;
  error?: string | null;
}

/**
 * The key form: every field the provider needs, one Save for all of them.
 * Several fields share one bordered box — they are one credential.
 */
export function ProviderKeyForm({
  entry,
  values,
  onValueChange,
  onSave,
  onCancel,
  saving,
  error,
}: ProviderKeyFormProps) {
  const t = useTranslations('providerSheet');
  const complete = entry.envVars.every((envVar) => (values[envVar] ?? '').trim().length > 0);
  const multi = entry.envVars.length > 1;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete && !saving) onSave();
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-provider-key-form={entry.id}>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-foreground text-sm font-medium">{t('apiKey')}</span>
          {!multi ? (
            <code className="text-muted-foreground truncate font-mono text-xs">{entry.envVars[0]}</code>
          ) : null}
        </div>
        <div
          className={cn(
            multi && 'border-border divide-border bg-input divide-y overflow-hidden rounded-md border',
            multi && error && 'border-destructive',
          )}
        >
          {entry.envVars.map((envVar, index) => (
            <div key={envVar}>
              <label htmlFor={providerKeyFieldId(entry.id, envVar)} className="sr-only">
                {entry.label} {prettyFieldLabel(envVar)}
              </label>
              <InputGroup
                className={cn(multi && 'rounded-none border-0', !multi && error && 'border-destructive')}
              >
                <InputGroupInput
                  id={providerKeyFieldId(entry.id, envVar)}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={index === 0}
                  // Password managers would offer to save a provider key as a
                  // login for this site. These are the vendors' opt-outs.
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-form-type="other"
                  aria-invalid={error ? true : undefined}
                  placeholder={
                    entry.models && entry.authRequirement
                      ? envVarPlaceholder(entry as LlmProviderEntry, envVar)
                      : prettyFieldLabel(envVar)
                  }
                  value={values[envVar] ?? ''}
                  onChange={(event) => onValueChange(envVar, event.target.value)}
                  className={cn(!multi && 'font-mono')}
                />
              </InputGroup>
            </div>
          ))}
        </div>
        {multi ? (
          <p className="text-muted-foreground font-mono text-xs break-all">
            {entry.envVars.join(' · ')}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-xs text-pretty">
            {error}
          </p>
        ) : null}
      </div>

      {entry.helpUrl ? (
        <a
          href={entry.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-[color] duration-(--duration-normal)"
        >
          {t('getKey', { name: entry.label })}
          <ArrowSquareOutIcon className="size-3 shrink-0" />
        </a>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!complete || saving} className="gap-1.5">
          {saving ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('saveKey')}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            {t('cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** A stored key. It can never be read back, so the field shows that one exists. */
export function SavedKey({
  envVars,
  onReplace,
}: {
  envVars: readonly string[];
  onReplace?: () => void;
}) {
  const t = useTranslations('providerSheet');
  return (
    <div className="space-y-1.5" data-provider-saved-key="">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground text-sm font-medium">{t('apiKey')}</span>
        <code className="text-muted-foreground truncate font-mono text-xs">{envVars.join(' · ')}</code>
      </div>
      <div className="flex items-center gap-2">
        <div className="bg-muted text-muted-foreground flex h-9 min-w-0 flex-1 items-center rounded-md px-3 text-sm">
          <span aria-hidden className="truncate font-mono tracking-widest">
            ••••••••••••••••
          </span>
          <span className="sr-only">{t('savedKey')}</span>
        </div>
        {onReplace ? (
          <Button type="button" size="sm" variant="secondary" onClick={onReplace}>
            {t('replace')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Two ways in: a subscription sign-in or an API key. */
export function ConnectChoice({
  name,
  plan,
  providerLabel,
  onSignIn,
  onUseKey,
}: {
  name: string;
  plan: string;
  providerLabel: string;
  onSignIn: () => void;
  onUseKey: () => void;
}) {
  const t = useTranslations('providerSheet');
  return (
    <div className="space-y-3" data-provider-connect-choice="">
      <div className="border-border space-y-3 rounded-lg border p-4">
        <div className="space-y-1.5">
          <Badge variant="info" size="sm">
            {t('fewerSteps')}
          </Badge>
          <p className="text-foreground text-sm font-medium">{t('signInTitle', { name })}</p>
          <p className="text-muted-foreground text-xs text-pretty">{t('signInBody', { plan })}</p>
        </div>
        <Button type="button" size="sm" className="w-full" onClick={onSignIn}>
          {t('signInAction', { name })}
        </Button>
      </div>
      <div className="border-border space-y-3 rounded-lg border p-4">
        <div className="space-y-1.5">
          <Badge variant="muted" size="sm">
            {t('payPerUse')}
          </Badge>
          <p className="text-foreground text-sm font-medium">{t('keyOptionTitle')}</p>
          <p className="text-muted-foreground text-xs text-pretty">
            {t('keyOptionBody', { name: providerLabel })}
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" className="w-full" onClick={onUseKey}>
          {t('keyOptionAction')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs text-pretty">{t('bothHint')}</p>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The device-grant step: the code, where to enter it, and that we are waiting. */
export function DeviceCode({
  name,
  code,
  url,
  onCopy,
}: {
  name: string;
  code: string | null;
  url: string | null;
  onCopy: () => void;
}) {
  const t = useTranslations('providerSheet');
  return (
    <div className="space-y-5" data-provider-device-code="">
      {code && url ? (
        <div className="bg-muted/60 space-y-3 rounded-lg p-4">
          <p className="text-muted-foreground text-xs">{t('yourCode')}</p>
          <div className="flex flex-wrap items-center gap-1.5" aria-label={code}>
            {Array.from(code).map((char, index) =>
              char === '-' ? (
                <span key={index} aria-hidden className="text-muted-foreground px-0.5">
                  –
                </span>
              ) : (
                <span
                  key={index}
                  aria-hidden
                  className="bg-background border-border text-foreground flex h-11 w-9 items-center justify-center rounded-md border font-mono text-lg font-medium"
                >
                  {char}
                </span>
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" className="gap-1.5" onClick={onCopy}>
              <Copy className="size-3.5 shrink-0" />
              {t('copyCode')}
            </Button>
            <Button size="sm" className="gap-1.5" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
                {t('openLink', { host: hostOf(url) })}
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
              </a>
            </Button>
          </div>
        </div>
      ) : null}

      {code ? (
        <Stepper orientation="vertical" value={1} count={3} className="flex flex-col">
          {[t('step1', { name }), t('step2'), t('step3')].map((step, index) => (
            <div key={step} className="flex gap-3">
              <StepperItem step={index + 1} className="items-center">
                <StepperTrigger asChild>
                  <StepperIndicator className="tabular-nums">{index + 1}</StepperIndicator>
                </StepperTrigger>
                <StepperSeparator className="bg-border m-0 my-1 group-data-[orientation=vertical]/stepper:min-h-3" />
              </StepperItem>
              <StepperTitle
                className={cn(
                  'text-foreground pt-0.5 font-normal',
                  index < 2 && 'pb-4',
                )}
              >
                {step}
              </StepperTitle>
            </div>
          ))}
        </Stepper>
      ) : null}

      <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loading className="size-3.5 shrink-0" />
        {code ? t('waitingBrowser') : t('startingSignIn')}
      </p>
    </div>
  );
}

/** One connection of a two-way provider: a sign-in or a key. */
function ConnectionRow({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">{detail}</span>
      </span>
      {action}
    </li>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/** Save and remove for one provider's key. */
export function useProviderKey(projectId: string, entry: LlmProviderEntry | undefined) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (target: LlmProviderEntry) => {
      // LLM provider credentials are ALWAYS project-wide — a per-user key is
      // invisible to the gateway's shared-row resolution and every model turn
      // dies with "No upstream configured" (2026-07-07 prod incident).
      await Promise.all(
        target.envVars.map((envVar) =>
          upsertProjectSecret(projectId, {
            name: envVar,
            value: (values[envVar] ?? '').trim(),
            strategy: 'broker',
            consumer: 'llm_gateway',
          }),
        ),
      );
      return target;
    },
    onSuccess: (target) => {
      successToast(tI18nComplete('textbc8686cf8d63', { value0: target.label }));
      setValues({});
      setError(null);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: target.id });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to save credentials';
      errorToast(message);
      setError(message);
    },
  });

  const remove = useMutation({
    mutationFn: async (target: LlmProviderEntry) => {
      const plan = providerDisconnectPlan(target);
      await Promise.all([
        ...(plan.oauthProvider ? [deleteProjectProviderOAuth(projectId, plan.oauthProvider)] : []),
        ...plan.secretNames.map((name) => deleteProjectSecret(projectId, name)),
      ]);
      return target;
    },
    onSuccess: (target) => {
      successToast(tI18nComplete('textb7e29198fc4e', { value0: target.label }));
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('textb89e92d0b992')),
  });

  return {
    values,
    error,
    setValue: (envVar: string, value: string) => {
      setValues((current) => ({ ...current, [envVar]: value }));
      // Typing is the retry: a red field must not argue with a corrected key.
      setError(null);
    },
    reset: () => {
      setValues({});
      setError(null);
    },
    save: () => entry && save.mutateAsync(entry).then(() => true, () => false),
    saving: save.isPending,
    remove: () => entry && remove.mutateAsync(entry).then(() => true, () => false),
    removing: remove.isPending,
  };
}

export function RemoveKeyDialog({
  open,
  onOpenChange,
  entry,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: LlmProviderEntry;
  pending: boolean;
  onConfirm: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tI18nComplete.raw('text088c3ffd67b6')}
      confirmLabel={tI18nComplete.raw('text81c45fd9b904')}
      confirmVariant="destructive"
      confirmIcon={<Unplug className="size-3.5 shrink-0" />}
      isPending={pending}
      onConfirm={onConfirm}
      description={
        <span className="text-xs">
          {tI18nComplete.raw('texta99dfc3d112a')}{' '}
          <span className="text-foreground font-medium">{entry.label}</span>
          {entry.models.length > 0 && (
            <>
              {' '}
              {tI18nComplete.raw('textedfd52be9cbc')} {entry.models.length}{' '}
              {tI18nComplete.raw('text9372c470eead')}
              {entry.models.length === 1 ? '' : 's'}
            </>
          )}
          {tI18nComplete.raw('text61c922500051')}
        </span>
      }
    />
  );
}

interface BodyProps {
  projectId: string;
  entry: LlmProviderEntry;
  connected: boolean;
  canWrite: boolean;
  models: ReactNode;
}

/** An API-key provider: the saved key or the form, and Remove in the footer. */
function KeyBody({ projectId, entry, connected, canWrite, models }: BodyProps) {
  const t = useTranslations('providerSheet');
  const key = useProviderKey(projectId, entry);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const showForm = canWrite && (!connected || editing);

  return (
    <>
      <SplitSheetBody className="space-y-7">
        {showForm ? (
          <ProviderKeyForm
            entry={entry}
            values={key.values}
            onValueChange={key.setValue}
            saving={key.saving}
            error={key.error}
            onCancel={
              connected
                ? () => {
                    key.reset();
                    setEditing(false);
                  }
                : undefined
            }
            onSave={() => void key.save()?.then((ok) => ok && setEditing(false))}
          />
        ) : connected ? (
          <SavedKey envVars={entry.envVars} onReplace={canWrite ? () => setEditing(true) : undefined} />
        ) : (
          <p className="text-muted-foreground text-sm text-pretty">{t('readOnly')}</p>
        )}
        {models}
      </SplitSheetBody>
      <SplitSheetFooter className="justify-between">
        {connected && canWrite ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive -ml-2"
            onClick={() => setConfirmRemove(true)}
          >
            {t('removeKey')}
          </Button>
        ) : (
          <span />
        )}
        <span className="text-muted-foreground text-xs">{t('storedEncrypted')}</span>
      </SplitSheetFooter>
      <RemoveKeyDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        entry={entry}
        pending={key.removing}
        onConfirm={() => void key.remove()?.then((ok) => ok && setConfirmRemove(false))}
      />
    </>
  );
}

/**
 * OpenAI / OpenCode Go: a subscription sign-in AND an API key, either or both.
 * Nothing connected → the choice. Signing in → the device code. Anything
 * connected → the connections, each removable, and the missing one offered.
 */
function SubscriptionBody({ projectId, entry, connected: keyConnected, canWrite, models }: BodyProps) {
  const t = useTranslations('providerSheet');
  const sub = SUBSCRIPTION_BY_PROVIDER[entry.id]!;
  const sign = useSubscriptionSignIn({ projectId, kind: sub.kind, onConnected: () => undefined });
  const key = useProviderKey(projectId, entry);
  const [addingKey, setAddingKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const waiting = sign.phase === 'waiting';
  const anyConnected = sign.connected || keyConnected;

  const copyCode = () => {
    if (!sign.challenge?.code) return;
    void navigator.clipboard?.writeText(sign.challenge.code).then(() => successToast(t('codeCopied')));
  };

  let body: ReactNode;
  if (!canWrite) {
    body = anyConnected ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>;
  } else if (waiting) {
    body = (
      <DeviceCode
        name={sub.name}
        code={sign.challenge?.code ?? null}
        url={sign.challenge?.url ?? null}
        onCopy={copyCode}
      />
    );
  } else if (addingKey) {
    body = (
      <ProviderKeyForm
        entry={entry}
        values={key.values}
        onValueChange={key.setValue}
        saving={key.saving}
        error={key.error}
        onCancel={() => {
          key.reset();
          setAddingKey(false);
        }}
        onSave={() => void key.save()?.then((ok) => ok && setAddingKey(false))}
      />
    );
  } else if (!anyConnected) {
    body = (
      <ConnectChoice
        name={sub.name}
        plan={sub.plan}
        providerLabel={entry.label}
        onSignIn={() => void sign.start()}
        onUseKey={() => setAddingKey(true)}
      />
    );
  }

  const connections = anyConnected && !waiting && !addingKey && (
    <Section title={t('connections')}>
      <ul className="border-border divide-border divide-y rounded-lg border">
        {sign.connected ? (
          <ConnectionRow
            title={t('subscription', { plan: sub.plan })}
            detail={t('signedIn')}
            action={
              canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={sign.disconnect.isPending}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  {t('disconnect')}
                </Button>
              ) : null
            }
          />
        ) : null}
        {keyConnected ? (
          <ConnectionRow
            title={t('apiKey')}
            detail={t('savedKey')}
            action={
              canWrite ? (
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAddingKey(true)}>
                    {t('replace')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmRemove(true)}
                  >
                    {t('removeKey')}
                  </Button>
                </div>
              ) : null
            }
          />
        ) : null}
      </ul>
      {canWrite && !(sign.connected && keyConnected) ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => (sign.connected ? setAddingKey(true) : void sign.start())}
        >
          {sign.connected ? t('addKey') : t('signInTitle', { name: sub.name })}
        </Button>
      ) : null}
    </Section>
  );

  return (
    <>
      <SplitSheetBody className="space-y-7">
        {sign.error ? (
          <p role="alert" className="text-destructive text-xs text-pretty">
            {sign.error}
          </p>
        ) : null}
        {body}
        {connections}
        {!waiting ? models : null}
      </SplitSheetBody>
      <SplitSheetFooter className="justify-between">
        {waiting ? (
          <Button type="button" size="sm" variant="ghost" className="-ml-2" onClick={sign.cancel}>
            {t('cancel')}
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">{t('sharedNote')}</span>
        )}
      </SplitSheetFooter>
      <RemoveKeyDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        entry={entry}
        pending={key.removing}
        onConfirm={() => void key.remove()?.then((ok) => ok && setConfirmRemove(false))}
      />
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('disconnectTitle', { plan: sub.plan })}</AlertDialogTitle>
            <AlertDialogDescription>{t('disconnectBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={sign.disconnect.isPending}
              onClick={() => sign.disconnect.mutate()}
            >
              {t('disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export interface ProviderSheetProps {
  projectId: string;
  providerId: string;
  canWrite: boolean;
  enabled?: boolean;
}

/** The sheet's header and body for one provider. Render inside `SplitSheetContent`. */
export function ProviderSheet({
  projectId,
  providerId,
  canWrite,
  enabled = true,
}: ProviderSheetProps) {
  const t = useTranslations('providerSheet');
  const tAccess = useTranslations('modelAccess');
  const tPooled = useTranslations('pooledSecrets');
  const meta = useProviderMeta();
  const access = useModelAccess(enabled ? projectId : null);
  const managed = useManagedProvider(enabled ? projectId : null);
  const pooled = usePooledProviderIds(projectId, enabled);
  const { connectedProviders } = useConnectedProviders(projectId, enabled);

  const entry = providerId === 'kortix' ? managed : LLM_PROVIDER_BY_ID.get(providerId);
  if (!entry) return null;

  const method = providerMethod(entry);
  const connectedIdSet = new Set(connectedProviders.map((provider) => provider.id));
  const keyConnected = connectedProviders.some((provider) => provider.id === entry.id);
  const subscriptionConnected = connectedProviders.some(
    (provider) => provider.id === (entry.id === 'openai' ? 'codex' : entry.id),
  );
  const status: ProviderStatus =
    method === 'included'
      ? 'included'
      : keyConnected || subscriptionConnected || pooled.pooledProviderIds.has(entry.id)
        ? 'connected'
        : 'none';

  const accessData = access.data;
  const accessRow = accessData?.enforced ? (
    <ProviderAccessRow
      name={entry.id === 'kortix' ? tAccess('managedTitle') : entry.label}
      enabled={!accessData.disabledProviders.includes(entry.id)}
      isDefault={access.defaultProvider === entry.id}
      pending={access.isUpdating}
      canWrite={canWrite}
      onChange={(next) =>
        void access
          .setEnabled({ target: 'provider', id: entry.id, enabled: next })
          .catch((error: unknown) =>
            errorToast(error instanceof Error ? error.message : tAccess('providerError')),
          )
      }
    />
  ) : null;
  const models = (
    <>
      {status !== 'none' ? accessRow : null}
      <ProviderModelsList models={entry.models} connected={status !== 'none'} />
    </>
  );

  const bodyProps: BodyProps = { projectId, entry, connected: keyConnected, canWrite, models };
  let content: ReactNode;
  if (method === 'included') {
    content = (
      <SplitSheetBody className="space-y-7">
        <p className="text-muted-foreground text-sm text-pretty">{entry.hint}</p>
        {models}
      </SplitSheetBody>
    );
  } else if (pooled.pooledSecretsEnabled && pooled.accountId && entry.id === 'openai') {
    content = (
      <SplitSheetBody className="space-y-7">
        <div className="space-y-3">
          <p className="text-foreground text-sm font-medium">{tPooled('chatGptAccounts')}</p>
          <p className="text-muted-foreground text-xs text-pretty">{tPooled('oauthPrivateDescription')}</p>
          <AccountSecretResourcesPanel
            accountId={pooled.accountId}
            projectId={projectId}
            providerId="codex"
            providerName="ChatGPT Plus/Pro"
            envVar="CODEX_AUTH_JSON"
            canWrite
            oauth={{ projectId, onConnected: () => undefined }}
          />
          <ChatGptSubscriptionConnect projectId={projectId} onConnected={() => undefined} legacyOnly />
        </div>
        {models}
      </SplitSheetBody>
    );
  } else if (pooled.pooledSecretsEnabled && pooled.accountId && supportsPooledProviderKey(entry)) {
    content = (
      <SplitSheetBody className="space-y-7">
        <AccountSecretResourcesPanel
          accountId={pooled.accountId}
          projectId={projectId}
          providerId={entry.id}
          providerName={entry.label}
          envVar={entry.envVars[0]!}
          canWrite
        />
        {models}
      </SplitSheetBody>
    );
  } else if (SUBSCRIPTION_BY_PROVIDER[entry.id]) {
    content = <SubscriptionBody {...bodyProps} />;
  } else if (entry.envVars.length === 0) {
    content = (
      <SplitSheetBody className="space-y-7">
        <p className="text-muted-foreground text-sm text-pretty">{entry.hint}</p>
        {models}
      </SplitSheetBody>
    );
  } else {
    content = <KeyBody {...bodyProps} />;
  }

  return (
    <>
      <SplitSheetHeader closeLabel={t('close')} className="px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogoStatus providerId={entry.id} label={entry.label} status={status} size="large" />
          <div className="min-w-0 space-y-0.5">
            <SplitSheetTitle className="truncate text-base font-semibold">{entry.label}</SplitSheetTitle>
            <SplitSheetDescription>
              {meta(method, entry.models.length, entry.id, connectedVia(entry.id, connectedIdSet))}
            </SplitSheetDescription>
          </div>
        </div>
      </SplitSheetHeader>
      {/* Remount per provider: a half-typed key never follows you to the next one. */}
      <div key={entry.id} className="contents">
        {content}
      </div>
    </>
  );
}
