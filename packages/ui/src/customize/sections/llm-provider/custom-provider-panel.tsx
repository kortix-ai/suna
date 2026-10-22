'use client';

import { useTranslations } from '../../../i18n';
/**
 * `CustomProviderPanel` — the Custom tab's whole body.
 *
 * ## Why this is a tab and not a section
 *
 * It used to be section 4 of the API-keys screen, behind an "Add a custom
 * provider" button. That put a job almost nobody does — pointing Kortix at a
 * self-hosted or unlisted OpenAI-compatible endpoint — at the bottom of the
 * screen EVERYBODY uses to paste an Anthropic key, where it was one more
 * heading to read past on the way to nothing.
 *
 * A tab costs the people who need it one click and costs everyone else
 * nothing, which is the trade a tab exists to make.
 *
 * ## What a custom provider is
 *
 * An endpoint and a model list stored in Kortix (`useCustomLlmProviders`,
 * `GET/PUT/DELETE /projects/:id/custom-providers`), plus the optional project
 * secret `CUSTOM_<ID>_API_KEY`. The gateway serves the models to every
 * harness, so nothing is written into the repository.
 *
 * The form IS the tab (Paper board CP01). Saved providers list above it
 * (board CP02). A configured row opens the Models page's side sheet
 * (`useModelsPageSheet`): edit the endpoint and models, replace the key, or
 * delete the provider. A legacy row (`configured: false`: a key saved before
 * endpoints moved into Kortix) pre-fills the form with its id instead.
 */

import { type FormEvent, useState } from 'react';

import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { Field, FieldLabel } from '../../../primitives/field';
import { Input } from '../../../primitives/input';
import { InputGroup, InputGroupInput } from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { Skeleton } from '../../../primitives/skeleton';
import {
  SplitSheetBody,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetTitle,
} from '../../../primitives/split-sheet';
import { errorToast, successToast } from '../../../primitives/toast';
import { ProviderLogoStatus } from '../../providers/provider-connect';
import { cn } from '../../../internal/lib/utils';
import { type CustomLlmProvider, upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState, useCustomLlmProviders } from '@kortix/sdk/react';
import { CaretRightIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useModelsPageSheet } from '../models-page-sheet';
import { CustomProviderForm } from './custom-provider-form';

/** One saved custom provider: a configured row opens the sheet, a legacy row
 *  pre-fills the form. */
export function CustomProviderRow({
  provider,
  selected,
  onSelect,
}: {
  provider: CustomLlmProvider;
  selected: boolean;
  onSelect: (provider: CustomLlmProvider) => void;
}) {
  const t = useTranslations('customProvider');
  const { id, name, configured } = provider;
  return (
    <button
      type="button"
      data-custom-provider-row={id}
      aria-current={selected || undefined}
      onClick={() => onSelect(provider)}
      className={cn(
        'group flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'hover:bg-muted/60 transition-[background-color] duration-(--duration-normal) ease-out',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        selected && 'bg-muted hover:bg-muted',
      )}
    >
      <ProviderLogoStatus
        providerId={id}
        label={name}
        status={configured ? 'connected' : 'none'}
        size="medium"
      />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{name}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {configured ? (
            <span className="font-mono">{provider.base_url}</span>
          ) : (
            t('needsEndpoint')
          )}
        </span>
      </span>
      {configured ? (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t('modelCount', { count: provider.models.length })}
        </span>
      ) : (
        <span className="text-foreground shrink-0 text-xs font-medium">{t('addEndpoint')}</span>
      )}
      <CaretRightIcon
        className={cn(
          'text-muted-foreground size-3.5 shrink-0 transition-[color] duration-(--duration-normal)',
          'group-hover:text-foreground',
          selected && 'text-foreground',
        )}
      />
    </button>
  );
}

/** One label/value line in the provider detail. */
function DetailRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-2">
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className={cn('text-foreground min-w-0 truncate', mono ? 'font-mono text-xs' : 'text-sm')}>
        {value}
      </span>
    </div>
  );
}

type ModelDraft = { id: string; name: string };

/**
 * The endpoint editor in the sheet. The PUT replaces the provider's whole
 * definition, so this edits the full model list in place.
 */
function EndpointEditor({
  projectId,
  provider,
  onClose,
}: {
  projectId: string;
  provider: CustomLlmProvider;
  onClose: () => void;
}) {
  const t = useTranslations('customProvider');
  const tSheet = useTranslations('providerSheet');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const custom = useCustomLlmProviders(projectId);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? '');
  const [models, setModels] = useState<ModelDraft[]>(provider.models);

  const save = useMutation({
    mutationFn: () => {
      const trimmed = models
        .map((m) => ({ id: m.id.trim(), name: m.name.trim() }))
        .filter((m) => m.id || m.name);
      if (!name.trim() || !/^https?:\/\//.test(baseUrl.trim())) {
        throw new Error('Name and an http:// or https:// base URL are required');
      }
      if (trimmed.length === 0 || trimmed.some((m) => !m.id || !m.name || /\s/.test(m.id))) {
        throw new Error('Every model needs an ID without spaces and a name');
      }
      return custom.save(provider.id, { name: name.trim(), base_url: baseUrl.trim(), models: trimmed });
    },
    onSuccess: () => {
      successToast(t('saved'));
      onClose();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : t('saveFailed')),
  });

  const setModel = (index: number, patch: Partial<ModelDraft>) =>
    setModels((current) => current.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!save.isPending) save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4" data-custom-provider-edit="">
      <Field className="gap-1.5">
        <FieldLabel htmlFor={`custom-edit-name-${provider.id}`}>
          {tI18nComplete.raw('text2b7f6a84de91')}
        </FieldLabel>
        <Input
          id={`custom-edit-name-${provider.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor={`custom-edit-url-${provider.id}`}>
          {tI18nComplete.raw('text70589413a3c9')}
        </FieldLabel>
        <Input
          id={`custom-edit-url-${provider.id}`}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          className="font-mono"
        />
      </Field>
      <div className="space-y-2">
        <span className="text-foreground text-sm font-medium">{t('models')}</span>
        {models.map((model, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label={tI18nComplete.raw('text089ef2b6dbb3')}
              value={model.id}
              onChange={(event) => setModel(index, { id: event.target.value })}
              placeholder={tI18nComplete.raw('text34d316295094')}
              className="min-w-0 flex-1 font-mono"
            />
            <Input
              aria-label={tI18nComplete.raw('texta3c3370cc732')}
              value={model.name}
              onChange={(event) => setModel(index, { name: event.target.value })}
              placeholder={tI18nComplete.raw('textb70354a1faae')}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t('removeModel')}
              disabled={models.length === 1}
              onClick={() => setModels((current) => current.filter((_, i) => i !== index))}
            >
              <XIcon className="size-3.5 shrink-0" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2"
          onClick={() => setModels((current) => [...current, { id: '', name: '' }])}
        >
          {t('addModel')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending} className="gap-1.5">
          {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('saveProvider')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={onClose}>
          {tSheet('cancel')}
        </Button>
      </div>
    </form>
  );
}

/** One saved custom provider: its endpoint and models, its key, and Delete. */
function CustomProviderDetail({
  projectId,
  provider,
  onDeleted,
}: {
  projectId: string;
  provider: CustomLlmProvider;
  onDeleted: () => void;
}) {
  const t = useTranslations('customProvider');
  const tSheet = useTranslations('providerSheet');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const custom = useCustomLlmProviders(projectId);
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [value, setValue] = useState('');

  const replace = useMutation({
    mutationFn: () =>
      upsertProjectSecret(projectId, {
        name: provider.secret_name,
        value: value.trim(),
        strategy: 'broker',
        consumer: 'llm_gateway',
      }),
    onSuccess: () => {
      successToast(t('keyReplaced'));
      setValue('');
      setReplacing(false);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.customLlmProviders(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text2c07997249ab')),
  });

  const remove = useMutation({
    mutationFn: () => custom.remove(provider.id),
    onSuccess: () => {
      successToast(t('deleted'));
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      onDeleted();
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : t('deleteFailed')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && !replace.isPending) replace.mutate();
  };

  return (
    <>
      <SplitSheetHeader closeLabel={tSheet('close')} className="px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogoStatus providerId={provider.id} label={provider.name} status="connected" size="large" />
          <div className="min-w-0 space-y-0.5">
            <SplitSheetTitle className="truncate text-base font-semibold">{provider.name}</SplitSheetTitle>
            <SplitSheetDescription className="font-mono">{provider.id}</SplitSheetDescription>
          </div>
        </div>
      </SplitSheetHeader>
      <SplitSheetBody className="space-y-7">
        <section className="space-y-1">
          <h3 className="text-foreground text-sm font-medium">{t('endpoint')}</h3>
          {editing ? (
            <EndpointEditor projectId={projectId} provider={provider} onClose={() => setEditing(false)} />
          ) : (
            <>
              <div className="divide-border divide-y">
                <DetailRow label={tI18nComplete.raw('text70589413a3c9')} value={provider.base_url ?? ''} />
                <DetailRow
                  label={tI18nComplete.raw('text16f0ee47f993')}
                  value={provider.has_key ? provider.secret_name : t('noKey')}
                  mono={provider.has_key}
                />
              </div>
              <h3 className="text-foreground pt-4 text-sm font-medium">{t('models')}</h3>
              <div className="divide-border divide-y">
                {provider.models.map((model) => (
                  <DetailRow key={model.id} label={model.name} value={model.id} />
                ))}
              </div>
              <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => setEditing(true)}>
                {t('editEndpoint')}
              </Button>
            </>
          )}
        </section>

        <section className="space-y-1">
          {replacing ? (
            <form onSubmit={submit} className="space-y-3" data-custom-provider-replace="">
              <label htmlFor={`custom-replace-${provider.id}`} className="sr-only">
                {tI18nComplete.raw('text16f0ee47f993')}
              </label>
              <InputGroup>
                <InputGroupInput
                  id={`custom-replace-${provider.id}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-form-type="other"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={tI18nComplete.raw('textb009c6c5299f')}
                  className="font-mono"
                />
              </InputGroup>
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={!value.trim() || replace.isPending} className="gap-1.5">
                  {replace.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tSheet('saveKey')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={replace.isPending}
                  onClick={() => {
                    setValue('');
                    setReplacing(false);
                  }}
                >
                  {tSheet('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setReplacing(true)}>
              {provider.has_key ? t('replaceKey') : t('addKey')}
            </Button>
          )}
        </section>

        <p className="text-muted-foreground text-xs text-pretty">{t('gatewayNote')}</p>
      </SplitSheetBody>
      <SplitSheetFooter className="justify-between">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive -ml-2"
          onClick={() => setConfirmDelete(true)}
        >
          {t('deleteProvider')}
        </Button>
        <span className="text-muted-foreground text-xs">{tSheet('storedEncrypted')}</span>
      </SplitSheetFooter>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deleteTitle')}
        description={t('deleteBody', { name: provider.name })}
        confirmLabel={t('deleteProvider')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

export function CustomProviderPanel({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  canWrite?: boolean;
}) {
  const t = useTranslations('customProvider');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [openId, setOpenId] = useState<string | null>(null);
  // A legacy key's id, pre-filled into the form; the form remounts per value.
  const [prefillId, setPrefillId] = useState('');
  const [formKey, setFormKey] = useState(0);
  const custom = useCustomLlmProviders(canWrite ? projectId : null);
  const providers = custom.providers;
  const open = providers.find((p) => p.id === openId && p.configured) ?? null;
  // A saved provider opens in the Models page's one side sheet, beside the
  // whole page — not a second sheet inside this tab's column.
  const renderSheet = useModelsPageSheet(open !== null, () => setOpenId(null));

  if (!canWrite) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">{tI18nComplete.raw('textb4214ac48923')}</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          {tI18nComplete.raw('text09f1d00ed790')}
        </p>
      </div>
    );
  }

  const select = (provider: CustomLlmProvider) => {
    if (provider.configured) {
      setOpenId(provider.id);
      return;
    }
    setOpenId(null);
    setPrefillId(provider.id);
    setFormKey((k) => k + 1);
  };

  return (
    // `pt-2.5` + the shell's `space-y-5` = board CP01's 28px from the tab row.
    <div className="flex flex-col gap-8 pt-2.5">
      {/* Paper board CP02: what this project already has, above the form.
          Only when there is something to show — the form is the tab. */}
      {custom.isLoading ? (
        <Skeleton className="h-12 rounded-md" />
      ) : providers.length > 0 ? (
        <section className="flex flex-col gap-0.5" aria-label={t('group', { count: providers.length })}>
          <h3 className="text-muted-foreground px-3 pb-1 text-xs font-medium tabular-nums">
            {t('group', { count: providers.length })}
          </h3>
          {providers.map((provider) => (
            <CustomProviderRow
              key={provider.id}
              provider={provider}
              selected={openId === provider.id || (!provider.configured && prefillId === provider.id)}
              onSelect={select}
            />
          ))}
        </section>
      ) : null}

      <CustomProviderForm
        key={`${prefillId}-${formKey}`}
        projectId={projectId}
        initialId={prefillId}
        onSaved={(id) => {
          setPrefillId('');
          setFormKey((k) => k + 1);
          setOpenId(id);
        }}
      />

      {renderSheet(
        open ? (
          <CustomProviderDetail
            key={open.id}
            projectId={projectId}
            provider={open}
            onDeleted={() => setOpenId(null)}
          />
        ) : null,
      )}
    </div>
  );
}
