'use client';

import type { CapturePolicy, CapturePolicyRecord } from '@kortix/sdk';
import { useCapturePolicy, useSetCapturePolicy } from '@kortix/sdk/react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CaptureSubpageHeader, ManagersOnly } from '../capture-shell';
import { relativeTime } from '../capture-time';

function SwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p id={id} className="text-foreground text-sm font-medium">
          {title}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <Switch aria-labelledby={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function PolicySection({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.settings');
  const record = useCapturePolicy(projectId);
  if (record.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 rounded-md" />
        <Skeleton className="h-24 rounded-md" />
      </div>
    );
  }
  if (record.isError || !record.data) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => record.refetch()}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  }
  // Keyed by the saved version: a save or a refetch with a newer policy starts a fresh draft.
  return (
    <PolicyForm
      key={record.data.updated_at ?? 'default'}
      projectId={projectId}
      record={record.data}
    />
  );
}

function PolicyForm({ projectId, record }: { projectId: string; record: CapturePolicyRecord }) {
  const t = useTranslations('capture.settings');
  const locale = useLocale();
  const save = useSetCapturePolicy(projectId);
  const [draft, setDraft] = useState<CapturePolicy>(record.policy);
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.policy);
  const patch = <K extends keyof CapturePolicy>(key: K, value: Partial<CapturePolicy[K]>) =>
    setDraft((current) => ({ ...current, [key]: { ...(current[key] as object), ...value } }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft, {
      onSuccess: () => successToast(t('saved')),
      onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')),
    });
  };
  const whole = (value: string, max: number) =>
    Math.min(max, Math.max(0, Math.round(Number(value) || 0)));

  return (
    <form onSubmit={submit} className="space-y-8">
      <section className="space-y-4">
        <Label>{t('layersTitle')}</Label>
        <div className="bg-popover divide-border divide-y rounded-md border">
          <SwitchRow
            title={t('layer.screen')}
            description={t('layer.screenHint')}
            checked={draft.layers.screen}
            onChange={(screen) => patch('layers', { screen })}
          />
          <SwitchRow
            title={t('layer.actions')}
            description={t('layer.actionsHint')}
            checked={draft.layers.actions}
            onChange={(actions) => patch('layers', { actions })}
          />
          <SwitchRow
            title={t('layer.audio')}
            description={t('layer.audioHint')}
            checked={draft.layers.audio}
            onChange={(audio) => patch('layers', { audio })}
          />
        </div>
      </section>

      <section className="space-y-4">
        <Label>{t('privacyTitle')}</Label>
        <div className="bg-popover divide-border divide-y rounded-md border">
          <SwitchRow
            title={t('masking')}
            description={t('maskingHint')}
            checked={draft.privacy.redact_pii}
            onChange={(redact_pii) => patch('privacy', { redact_pii })}
          />
          <SwitchRow
            title={t('pause')}
            description={t('pauseHint')}
            checked={draft.recording.paused}
            onChange={(paused) => patch('recording', { paused, paused_until_ms: null })}
          />
        </div>
      </section>

      <section className="space-y-4">
        <Label>{t('retentionTitle')}</Label>
        <div className="bg-popover grid gap-4 rounded-md border px-4 py-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="capture-local-hours">{t('localHours')}</FieldLabel>
            <Input
              id="capture-local-hours"
              type="number"
              min={0}
              max={8760}
              value={draft.retention.local_hours}
              onChange={(event) =>
                patch('retention', { local_hours: whole(event.target.value, 8760) })
              }
            />
            <FieldDescription>{t('localHoursHint')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="capture-remote-days">{t('remoteDays')}</FieldLabel>
            <Input
              id="capture-remote-days"
              type="number"
              min={0}
              max={3650}
              value={draft.retention.remote_days}
              onChange={(event) =>
                patch('retention', { remote_days: whole(event.target.value, 3650) })
              }
            />
            <FieldDescription>{t('remoteDaysHint')}</FieldDescription>
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <Label htmlFor="capture-notice">{t('noticeTitle')}</Label>
        <div className="bg-popover space-y-2 rounded-md border px-4 py-5">
          <Textarea
            id="capture-notice"
            value={draft.notice}
            maxLength={2000}
            rows={3}
            placeholder={t('noticePlaceholder')}
            onChange={(event) => setDraft({ ...draft, notice: event.target.value })}
          />
          <p className="text-muted-foreground text-xs text-pretty">{t('noticeHint')}</p>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {record.updated_at
            ? t('lastChanged', { time: relativeTime(Date.parse(record.updated_at), locale) })
            : t('defaultPolicy')}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(record.policy)}
          >
            {t('discard')}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!dirty || save.isPending}
            aria-busy={save.isPending}
          >
            {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('save')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Settings — the project capture policy every device reads (`policy.json`). Managers only. */
export function CaptureSettingsView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.settings');
  return (
    <ManagersOnly projectId={projectId}>
      <CaptureSubpageHeader projectId={projectId} title={t('title')} />
      <CapabilityPageShell title={t('title')} description={t('description')}>
        <PolicySection projectId={projectId} />
      </CapabilityPageShell>
    </ManagersOnly>
  );
}
