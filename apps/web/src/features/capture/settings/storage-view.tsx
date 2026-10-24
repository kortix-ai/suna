'use client';

import type { CaptureStorageView } from '@kortix/sdk';
import { useCaptureStorage, useSetCaptureStorage } from '@kortix/sdk/react';
import { useId, useState } from 'react';

import { toDraft, toInput, validStorageDraft, type CredKind, type StorageDraft } from './storage-model';

import { Button } from '@kortix/ui/button';
import { Field, FieldDescription } from '@kortix/ui/field';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { Skeleton } from '@kortix/ui/skeleton';
import { Switch } from '@kortix/ui/switch';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ErrorState } from '@kortix/ui/error-state';
import { useTranslations } from '@/i18n/use-translations';

/** A stacked text field (values here are long: endpoints, ARNs, keys). */
function TextField({
  label,
  description,
  value,
  placeholder,
  type = 'text',
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function StorageForm({ accountId, view }: { accountId: string; view: CaptureStorageView }) {
  const t = useTranslations('capture.settings.storage');
  const save = useSetCaptureStorage(accountId);
  const [draft, setDraft] = useState<StorageDraft>(() => toDraft(view));
  const set = (patch: Partial<StorageDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    try {
      await save.mutateAsync(toInput(draft));
      successToast(t('saved'));
    } catch (error) {
      const err = error as { code?: string; message?: string };
      errorToast(err.code === 'capture_storage_unreachable' ? t('probeFailed', { error: err.message ?? '' }) : t('saveFailed'));
    }
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>{t('title')}</Label>
        <p className="text-muted-foreground text-xs text-pretty">{t('hint')}</p>
      </div>

      <RadioGroup
        value={draft.mode}
        onValueChange={(mode) => set({ mode: mode as StorageDraft['mode'] })}
        className="gap-0 overflow-hidden rounded-md border"
      >
        <label className="flex items-start gap-3 border-b px-4 py-3">
          <RadioGroupItem value="kortix" className="mt-0.5" />
          <span className="min-w-0">
            <span className="text-foreground block text-sm font-medium">{t('kortix')}</span>
            <span className="text-muted-foreground mt-0.5 block text-xs text-pretty">{t('kortixHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 px-4 py-3">
          <RadioGroupItem value="s3" className="mt-0.5" />
          <span className="min-w-0">
            <span className="text-foreground block text-sm font-medium">{t('s3')}</span>
            <span className="text-muted-foreground mt-0.5 block text-xs text-pretty">{t('s3Hint')}</span>
          </span>
        </label>
      </RadioGroup>

      {draft.mode === 's3' ? (
        <div className="space-y-4 rounded-md border p-4">
          <TextField label={t('bucket')} value={draft.bucket} placeholder="my-recordings" onChange={(bucket) => set({ bucket })} />
          <TextField label={t('region')} value={draft.region} placeholder="us-east-1" onChange={(region) => set({ region })} />
          <TextField label={t('endpoint')} description={t('endpointHint')} value={draft.endpoint} placeholder="https://s3.example.com" onChange={(endpoint) => set({ endpoint })} />
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">{t('pathStyle')}</p>
              <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('pathStyleHint')}</p>
            </div>
            <Switch checked={draft.forcePathStyle} onCheckedChange={(forcePathStyle) => set({ forcePathStyle })} />
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1">
              <Label>{t('credsTitle')}</Label>
              <p className="text-muted-foreground text-xs text-pretty">{t('credsHint')}</p>
            </div>
            <RadioGroup value={draft.credKind} onValueChange={(credKind) => set({ credKind: credKind as CredKind })} className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="role" /> {t('credRole')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="keys" /> {t('credKeys')}
              </label>
            </RadioGroup>
            {draft.credKind === 'role' ? (
              <TextField label={t('roleArn')} description={t('roleArnHint')} value={draft.roleArn} placeholder="arn:aws:iam::123456789012:role/kortix-capture" onChange={(roleArn) => set({ roleArn })} />
            ) : (
              <>
                <TextField label={t('accessKeyId')} value={draft.accessKeyId} onChange={(accessKeyId) => set({ accessKeyId })} />
                <TextField label={t('secretAccessKey')} type="password" value={draft.secretAccessKey} description={view.mode === 's3' && view.has_secret ? t('secretSet') : undefined} onChange={(secretAccessKey) => set({ secretAccessKey })} />
                <p className="text-muted-foreground text-xs text-pretty">{t('staticWarning')}</p>
              </>
            )}
          </div>

          <p className="text-muted-foreground border-t pt-4 text-xs text-pretty">{t('indexingNote')}</p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {view.mode === 's3' ? t('currentOwn', { bucket: view.bucket }) : t('currentManaged')}
        </p>
      )}

      <div className="flex justify-end">
        <Button size="sm" disabled={save.isPending || !validStorageDraft(draft)} aria-busy={save.isPending} onClick={submit}>
          {t('save')}
        </Button>
      </div>
    </section>
  );
}

/** The account's Capture storage destination (`capture.manage`). */
export function CaptureStoragePane({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings.storage');
  const tSettings = useTranslations('capture.settings');
  const storage = useCaptureStorage(accountId);

  if (storage.isLoading) return <Skeleton className="h-40 rounded-md" />;
  if (storage.isError || !storage.data) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => storage.refetch()}>
            {tSettings('tryAgain')}
          </Button>
        }
      />
    );
  }
  // Keyed by the stored shape so a save starts a fresh draft.
  return <StorageForm key={JSON.stringify(storage.data)} accountId={accountId} view={storage.data} />;
}
