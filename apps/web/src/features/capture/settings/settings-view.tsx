'use client';

import type { CaptureExclusionGroup, CapturePolicy, CapturePolicyRecord } from '@kortix/sdk';
import { useCapturePolicy, useSetCaptureEnabled, useSetCapturePolicy } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { notFound } from 'next/navigation';
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
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CapturePage } from '../area/capture-area-shell';
import { useCaptureArea } from '../area/use-capture-area';
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

const EXCLUSION_GROUPS: readonly CaptureExclusionGroup[] = [
  'password_managers',
  'messaging',
  'banking',
];

/** `https://www.Example.com/path` → `example.com`; the API checks the result. */
const hostOf = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '');

/** A list the admin adds to and removes from: excluded apps or websites. */
function ListEditor({
  title,
  description,
  placeholder,
  items,
  normalize = (value: string) => value.trim(),
  onChange,
}: {
  title: string;
  description: string;
  placeholder: string;
  items: string[];
  normalize?: (value: string) => string;
  onChange: (items: string[]) => void;
}) {
  const t = useTranslations('capture.settings.exclusions');
  const id = useId();
  const [value, setValue] = useState('');
  const add = () => {
    const next = normalize(value);
    if (next && !items.includes(next)) onChange([...items, next]);
    setValue('');
  };
  return (
    <div className="space-y-3 px-4 py-3">
      <div>
        <label htmlFor={id} className="text-foreground text-sm font-medium">
          {title}
        </label>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={!value.trim()} onClick={add}>
          {t('add')}
        </Button>
      </div>
      {items.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="bg-muted text-foreground flex items-center gap-1 rounded-sm py-0.5 pr-1 pl-2 text-xs"
            >
              {item}
              <button
                type="button"
                aria-label={t('remove', { item })}
                className="text-muted-foreground hover:text-foreground rounded-sm"
                onClick={() => onChange(items.filter((other) => other !== item))}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PolicySection({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const record = useCapturePolicy(accountId);
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
      accountId={accountId}
      record={record.data}
    />
  );
}

function PolicyForm({ accountId, record }: { accountId: string; record: CapturePolicyRecord }) {
  const t = useTranslations('capture.settings');
  const locale = useLocale();
  const save = useSetCapturePolicy(accountId);
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
        <div className="space-y-1">
          <Label>{t('exclusions.title')}</Label>
          <p className="text-muted-foreground text-xs text-pretty">{t('exclusions.hint')}</p>
        </div>
        <div className="bg-popover divide-border divide-y rounded-md border">
          {EXCLUSION_GROUPS.map((group) => (
            <SwitchRow
              key={group}
              title={t(`exclusions.group.${group}`)}
              description={t(`exclusions.group.${group}Hint`)}
              checked={draft.privacy.exclusion_groups.includes(group)}
              onChange={(on) =>
                patch('privacy', {
                  exclusion_groups: on
                    ? [...draft.privacy.exclusion_groups, group]
                    : draft.privacy.exclusion_groups.filter((other) => other !== group),
                })
              }
            />
          ))}
          <SwitchRow
            title={t('exclusions.privateBrowsing')}
            description={t('exclusions.privateBrowsingHint')}
            checked={draft.privacy.exclude_private_browsing}
            onChange={(exclude_private_browsing) => patch('privacy', { exclude_private_browsing })}
          />
          <ListEditor
            title={t('exclusions.apps')}
            description={t('exclusions.appsHint')}
            placeholder="com.apple.keychainaccess"
            items={draft.privacy.excluded_bundle_ids}
            onChange={(excluded_bundle_ids) => patch('privacy', { excluded_bundle_ids })}
          />
          <ListEditor
            title={t('exclusions.websites')}
            description={t('exclusions.websitesHint')}
            placeholder="bank.example.com"
            items={draft.privacy.excluded_domains}
            normalize={hostOf}
            onChange={(excluded_domains) => patch('privacy', { excluded_domains })}
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

/** The account switch: Kortix Capture on or off for the whole organization. */
function SwitchSection({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  const setEnabled = useSetCaptureEnabled(accountId);
  return (
    <section className="space-y-4">
      <Label>{t('switchTitle')}</Label>
      <div className="bg-popover rounded-md border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p id="capture-switch" className="text-foreground text-sm font-medium">
              {t('switchLabel', { name: area.accountName })}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
              {area.canManage ? t('switchHint') : t('switchOwnersOnly')}
            </p>
          </div>
          <Switch
            aria-labelledby="capture-switch"
            checked={area.enabled}
            disabled={!area.canManage || setEnabled.isPending}
            onCheckedChange={(on) =>
              setEnabled.mutate(on, {
                onSuccess: () => successToast(on ? t('switchedOn') : t('switchedOff')),
                onError: () => errorToast(t('switchFailed')),
              })
            }
          />
        </div>
      </div>
    </section>
  );
}

/** Who reads whose recordings: Kortix IAM, not a Capture setting. */
function AccessSection() {
  const t = useTranslations('capture.settings');
  return (
    <section className="space-y-2">
      <Label>{t('accessTitle')}</Label>
      <p className="text-muted-foreground text-sm text-pretty">{t('accessBody')}</p>
    </section>
  );
}

/**
 * Settings (`/capture/[accountId]/settings`), `capture.manage` only: the
 * account switch, who sees what, and the policy every device reads.
 */
export function CaptureSettingsView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  if (!area.canManage) notFound();
  return (
    <CapturePage title={t('title')} description={t('description', { name: area.accountName })}>
      <div className="w-full max-w-2xl space-y-8">
        <SwitchSection accountId={accountId} />
        <AccessSection />
        <PolicySection accountId={accountId} />
      </div>
    </CapturePage>
  );
}
