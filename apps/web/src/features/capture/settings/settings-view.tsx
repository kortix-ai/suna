'use client';

import {
  CAPTURE_LAYERS,
  CAPTURE_RETENTION_LIMITS,
  type CapturePolicy,
  type CapturePolicyRecord,
} from '@kortix/sdk';
import { useCapturePolicy, useSetCapturePolicy } from '@kortix/sdk/react';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@/lib/relative-time';
import { useCaptureArea } from '../area/use-capture-area';
import { ExclusionsEditor } from './exclusions-editor';
import { applyToPrivacy, fromPolicy } from './exclusions-model';

function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
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
      <Switch
        aria-labelledby={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label>{title}</Label>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="bg-popover divide-border divide-y rounded-md border">{children}</div>
    </section>
  );
}

/** A whole number with its unit, right-aligned like a switch. */
function NumberRow({
  id,
  title,
  description,
  unit,
  value,
  max,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  unit: string;
  value: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-foreground text-sm font-medium">
          {title}
        </Label>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-20 tabular-nums"
        />
        <span className="text-muted-foreground text-sm">{unit}</span>
      </span>
    </div>
  );
}

/**
 * Kortix Capture's organization settings, the `capture` section of the
 * account settings (`?accountTab=capture`), `capture.manage` only: what every
 * device of the organization must do, in the order This computer shows it.
 * What is recorded · Exclusions (mandatory) · Retention · Notice · Pause ·
 * Experimental (local masking). The policy is one draft; the save bar shows while it differs from
 * what is stored. The switch that turns Capture on is in the account's
 * Settings. A member's own exclusions live on their computer and never reach
 * Kortix. The account settings pane supplies the heading.
 */
export function CaptureSettingsPane({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  const record = useCapturePolicy(accountId);

  return record.isLoading ? (
    <div className="space-y-3">
      <Skeleton className="h-9 w-80 rounded-md" />
      <Skeleton className="h-32 rounded-md" />
    </div>
  ) : record.isError || !record.data ? (
    <ErrorState
      size="sm"
      title={t('loadFailed')}
      action={
        <Button variant="outline" size="sm" onClick={() => record.refetch()}>
          {t('tryAgain')}
        </Button>
      }
    />
  ) : (
    // Keyed by the saved version: a save or a newer policy starts a fresh draft.
    <PolicyForm
      key={record.data.updated_at ?? 'default'}
      accountId={accountId}
      org={area.accountName}
      record={record.data}
    />
  );
}

function PolicyForm({
  accountId,
  org,
  record,
}: {
  accountId: string;
  org: string;
  record: CapturePolicyRecord;
}) {
  const t = useTranslations('capture.settings');
  const tGroup = useTranslations('capture.settings.exclusions.group');
  const locale = useLocale();
  const save = useSetCapturePolicy(accountId);
  const [draft, setDraft] = useState<CapturePolicy>(record.policy);
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.policy);
  const patch = <K extends keyof CapturePolicy>(key: K, value: Partial<CapturePolicy[K]>) =>
    setDraft((current) => ({ ...current, [key]: { ...(current[key] as object), ...value } }));
  const whole = (value: string, max: number) =>
    Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  const submit = () =>
    save.mutate(draft, {
      onSuccess: () => successToast(t('saved')),
      onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')),
    });

  return (
    <div className="space-y-10">
      <Group title={t('layersTitle')} description={t('layersHint', { org })}>
        {CAPTURE_LAYERS.map((layer) => (
          <SwitchRow
            key={layer}
            title={t(`layer.${layer}`)}
            description={t(`layer.${layer}Hint`)}
            checked={draft.layers[layer]}
            onChange={(on) => patch('layers', { [layer]: on })}
          />
        ))}
      </Group>

      <section className="space-y-1">
        <Label>{t('exclusionsTitle')}</Label>
        <ExclusionsEditor
          mode="org"
          org={org}
          view={fromPolicy(draft.privacy, (id) => ({
            name: tGroup(id),
            description: tGroup(`${id}Hint`),
          }))}
          onChange={(change) =>
            setDraft((current) => ({
              ...current,
              privacy: applyToPrivacy(current.privacy, change),
            }))
          }
        />
      </section>

      <Group title={t('retentionTitle')}>
        <NumberRow
          id="capture-local-hours"
          title={t('localHours')}
          description={t('localHoursHint')}
          unit={t('hours')}
          value={draft.retention.local_hours}
          max={CAPTURE_RETENTION_LIMITS.localHours}
          onChange={(value) =>
            patch('retention', {
              local_hours: whole(value, CAPTURE_RETENTION_LIMITS.localHours),
            })
          }
        />
        <NumberRow
          id="capture-remote-days"
          title={t('remoteDays')}
          description={t('remoteDaysHint')}
          unit={t('days')}
          value={draft.retention.remote_days}
          max={CAPTURE_RETENTION_LIMITS.remoteDays}
          onChange={(value) =>
            patch('retention', {
              remote_days: whole(value, CAPTURE_RETENTION_LIMITS.remoteDays),
            })
          }
        />
      </Group>

      <section className="space-y-3">
        <Label htmlFor="capture-notice">{t('noticeTitle')}</Label>
        <Field>
          <Textarea
            id="capture-notice"
            value={draft.notice}
            maxLength={2000}
            rows={3}
            placeholder={t('noticePlaceholder')}
            onChange={(event) => setDraft({ ...draft, notice: event.target.value })}
          />
          <FieldDescription>{t('noticeHint')}</FieldDescription>
        </Field>
      </section>

      <Group title={t('pauseTitle')}>
        <SwitchRow
          title={t('pause')}
          description={t('pauseHint')}
          checked={draft.recording.paused}
          onChange={(paused) => patch('recording', { paused, paused_until_ms: null })}
        />
      </Group>

      {/* Experimental: works, and costs each computer a ~1 GB model download first. */}
      <Group title={t('experimentalTitle')} description={t('experimentalHint')}>
        <SwitchRow
          title={t('masking')}
          description={t('maskingHint')}
          checked={draft.privacy.redact_pii}
          onChange={(redact_pii) => patch('privacy', { redact_pii })}
        />
      </Group>

      <section className="space-y-2">
        <Label>{t('accessTitle')}</Label>
        <p className="text-muted-foreground text-sm text-pretty">{t('accessBody')}</p>
      </section>

      {dirty ? (
        <div className="bg-background sticky bottom-0 z-10 mt-8 flex flex-wrap items-center justify-between gap-3 border-t py-3">
          <p className="text-muted-foreground text-xs">{t('unsaved')}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline-ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => setDraft(record.policy)}
            >
              {t('discard')}
            </Button>
            <Button size="sm" disabled={save.isPending} aria-busy={save.isPending} onClick={submit}>
              {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {t('save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground mt-8 text-xs">
          {record.updated_at
            ? t('lastChanged', { time: relativeTime(Date.parse(record.updated_at), locale) })
            : t('defaultPolicy')}
        </p>
      )}
    </div>
  );
}
