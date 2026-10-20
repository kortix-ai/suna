'use client';

import {
  CAPTURE_FRAME_INTERVALS_MS,
  CAPTURE_LAYERS,
  CAPTURE_MAX_HEIGHTS,
  CAPTURE_RETENTION_LIMITS,
  type CaptureMaxHeight,
  type CapturePolicy,
  type CapturePolicyRecord,
} from '@kortix/sdk';
import { useCapturePolicy, useSetCapturePolicy } from '@kortix/sdk/react';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '@kortix/ui/button';
import { Field, FieldDescription } from '@kortix/ui/field';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { Switch } from '@kortix/ui/switch';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ErrorState } from '@kortix/ui/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { useCaptureArea } from '@kortix/ui/internal/capture/use-capture-area';
import { ExclusionsEditor, IncludedEditor } from './exclusions-editor';
import { applyToPrivacy, fromPolicy, includedView } from './exclusions-model';

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

/** A choice from a short list, or none (each computer decides), right-aligned like a switch. */
function SelectRow<T extends number>({
  title,
  description,
  value,
  noneLabel,
  options,
  onChange,
}: {
  title: string;
  description: string;
  value: T | null;
  noneLabel: string;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | null) => void;
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
      <Select
        value={value === null ? 'none' : String(value)}
        onValueChange={(next) => onChange(next === 'none' ? null : (Number(next) as T))}
      >
        <SelectTrigger size="sm" aria-labelledby={id} className="w-56 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{noneLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
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
 * What is recorded · Screen frames · Exclusions (mandatory) · Retention · Notice · Pause ·
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
  const privacyControls = draft.experimental?.privacy_controls ?? false;
  const recordOnly = draft.privacy.record_only_included ?? false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.policy);
  const patch = <K extends keyof CapturePolicy>(key: K, value: Partial<CapturePolicy[K]>) =>
    setDraft((current) => ({ ...current, [key]: { ...(current[key] as object), ...value } }));
  const whole = (value: string, max: number) =>
    Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  // Frame rate and size: null leaves each computer its own; a value applies to every computer.
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

      <section className="space-y-4">
        <div className="space-y-1">
          <Label>{t('included.title')}</Label>
          <p className="text-muted-foreground text-xs">{t('included.hint', { org })}</p>
        </div>
        <RadioGroup
          value={recordOnly ? 'include' : 'exclude'}
          onValueChange={(mode) =>
            setDraft((current) => ({
              ...current,
              privacy: applyToPrivacy(current.privacy, {
                kind: 'record-only',
                on: mode === 'include',
              }),
            }))
          }
          className="grid gap-2 sm:grid-cols-2"
          aria-label={t('included.policyType')}
        >
          <RadioGroupItem
            value="exclude"
            label={t('included.exclusionPolicy')}
            description={t('included.exclusionPolicyHint')}
            size="lg"
            variant="outline"
          />
          <RadioGroupItem
            value="include"
            label={t('included.inclusionPolicy')}
            description={t('included.inclusionPolicyHint')}
            size="lg"
            variant="outline"
          />
        </RadioGroup>
        {recordOnly ? (
          <div className="space-y-1 pt-2">
            <Label>{t('included.recordTitle')}</Label>
            <IncludedEditor
              view={includedView(draft.privacy)}
              onChange={(change) =>
                setDraft((current) => ({
                  ...current,
                  privacy: applyToPrivacy(current.privacy, change),
                }))
              }
            />
            <div className="bg-popover mt-3 rounded-md border">
              <SwitchRow
                title={t('included.memberInclusions')}
                description={t('included.memberInclusionsHint')}
                checked={draft.privacy.member_inclusions ?? true}
                onChange={(on) =>
                  setDraft((current) => ({
                    ...current,
                    privacy: applyToPrivacy(current.privacy, { kind: 'member-inclusions', on }),
                  }))
                }
              />
            </div>
          </div>
        ) : null}
        <div className="space-y-1 pt-2">
          <Label>{recordOnly ? t('included.exceptTitle') : t('exclusionsTitle')}</Label>
          <ExclusionsEditor
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
        </div>
      </section>

      <Group title={t('framesTitle')} description={t('framesHint')}>
        <SelectRow
          title={t('interval')}
          description={t('intervalHint')}
          value={draft.recording.interval_ms ?? null}
          noneLabel={t('computerDecides')}
          options={CAPTURE_FRAME_INTERVALS_MS.map((ms) => ({
            value: ms,
            label: t('intervalOption', { seconds: ms / 1000 }),
          }))}
          onChange={(interval_ms) => patch('recording', { interval_ms })}
        />
        <SelectRow<CaptureMaxHeight>
          title={t('resolution')}
          description={t('resolutionHint')}
          value={draft.recording.max_height ?? null}
          noneLabel={t('computerDecides')}
          options={CAPTURE_MAX_HEIGHTS.map((height) => ({
            value: height,
            label: height === 2160 ? '4K' : `${height}p`,
          }))}
          onChange={(max_height) => patch('recording', { max_height })}
        />
      </Group>

      <Group title={t('retentionTitle')}>
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

      <Group title={t('experimentalTitle')} description={t('experimentalHint')}>
        <SwitchRow
          title={t('privacyControls')}
          description={t('privacyControlsHint')}
          checked={privacyControls}
          onChange={(privacy_controls) => patch('experimental', { privacy_controls })}
        />
      </Group>

      {privacyControls ? (
        <>
          {/* Works, and costs each computer a ~1 GB model download first. */}
          <Group title={t('maskingTitle')}>
            <SwitchRow
              title={t('masking')}
              description={t('maskingHint')}
              checked={draft.privacy.redact_pii}
              onChange={(redact_pii) => patch('privacy', { redact_pii })}
            />
          </Group>
        </>
      ) : null}

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
