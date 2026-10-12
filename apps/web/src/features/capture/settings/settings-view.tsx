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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@/lib/relative-time';
import { CaptureAccountCard } from '../area/capture-account-card';
import { useCaptureArea } from '../area/use-capture-area';
import { ExclusionsEditor } from './exclusions-editor';
import { applyToPrivacy, fromPolicy } from './exclusions-model';

const TABS = ['general', 'recording', 'exclusions', 'retention', 'notice'] as const;
type SettingsTab = (typeof TABS)[number];

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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <Label>{title}</Label>
      <div className="bg-popover divide-border divide-y rounded-md border">{children}</div>
    </section>
  );
}

/**
 * Kortix Capture's organization settings, the `capture` section of the
 * account settings (`?accountTab=capture`), `capture.manage` only: what every
 * device of the organization must do. General (the switch, who sees what) ·
 * Recording · Exclusions (mandatory) · Retention · Notice. The policy is one
 * draft across the tabs; the save bar shows while it differs from what is
 * stored. A member's own choices live on their computer, in the desktop app,
 * and never reach Kortix. The account settings pane supplies the heading.
 */
export function CaptureSettingsPane({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  const record = useCapturePolicy(accountId);
  // Local, not a URL param: the pane opens over any page, whose `?tab=` is not its own.
  const [tab, setTab] = useState<SettingsTab>('general');

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
      tab={tab}
      onTab={(next) => setTab(next as SettingsTab)}
    />
  );
}

function PolicyForm({
  accountId,
  org,
  record,
  tab,
  onTab,
}: {
  accountId: string;
  org: string;
  record: CapturePolicyRecord;
  tab: SettingsTab;
  onTab: (tab: string) => void;
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
    <Tabs value={tab} onValueChange={onTab}>
      <TabsList type="underline" aria-label={t('tabs.label')}>
        {TABS.map((value) => (
          <TabsTrigger key={value} value={value}>
            {t(`tabs.${value}`)}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="general" className="space-y-8 pt-6">
        <div className="bg-popover rounded-md border">
          <CaptureAccountCard accountId={accountId} />
        </div>
        <section className="space-y-2">
          <Label>{t('accessTitle')}</Label>
          <p className="text-muted-foreground text-sm text-pretty">{t('accessBody')}</p>
        </section>
      </TabsContent>

      <TabsContent value="recording" className="space-y-8 pt-6">
        <Group title={t('layersTitle')}>
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
        <Group title={t('privacyTitle')}>
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
        </Group>
      </TabsContent>

      <TabsContent value="exclusions" className="pt-6">
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
      </TabsContent>

      <TabsContent value="retention" className="pt-6">
        <div className="bg-popover grid gap-4 rounded-md border px-4 py-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="capture-local-hours">{t('localHours')}</FieldLabel>
            <Input
              id="capture-local-hours"
              type="number"
              min={0}
              max={CAPTURE_RETENTION_LIMITS.localHours}
              value={draft.retention.local_hours}
              onChange={(event) =>
                patch('retention', {
                  local_hours: whole(event.target.value, CAPTURE_RETENTION_LIMITS.localHours),
                })
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
              max={CAPTURE_RETENTION_LIMITS.remoteDays}
              value={draft.retention.remote_days}
              onChange={(event) =>
                patch('retention', {
                  remote_days: whole(event.target.value, CAPTURE_RETENTION_LIMITS.remoteDays),
                })
              }
            />
            <FieldDescription>{t('remoteDaysHint')}</FieldDescription>
          </Field>
        </div>
      </TabsContent>

      <TabsContent value="notice" className="pt-6">
        <Field>
          <FieldLabel htmlFor="capture-notice">{t('noticeTitle')}</FieldLabel>
          <Textarea
            id="capture-notice"
            value={draft.notice}
            maxLength={2000}
            rows={4}
            placeholder={t('noticePlaceholder')}
            onChange={(event) => setDraft({ ...draft, notice: event.target.value })}
          />
          <FieldDescription>{t('noticeHint')}</FieldDescription>
        </Field>
      </TabsContent>

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
    </Tabs>
  );
}
