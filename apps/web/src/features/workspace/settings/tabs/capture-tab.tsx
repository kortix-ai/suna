'use client';

/**
 * Capture — Kortix Capture's three scopes on one pane.
 *
 * - Workspace: the account's switch, retention and the admin-view rule.
 *   Owners and admins change them; a member reads them, because a member must
 *   see whether admins can open their captures.
 * - Your computers: each machine the caller paired, with its own switch and
 *   the workspace it records into. Only the machine's owner changes these.
 * - Your data: the caller deletes their own captures.
 */

import {
  deleteCaptureData,
  updateCaptureDevice,
  updateCaptureSettings,
  type CaptureDevice,
} from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { dayBounds, deviceStatus, localDay } from '@/features/capture/capture-model';
import { ThisComputer } from '@/features/capture/desktop-recorder';
import { captureKeys, useCaptureAccount, useCaptureDevices } from '@/features/capture/use-capture';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { SettingsTabHeader } from '../settings-tab-header';

function formatWhen(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function CaptureTab() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="capture" />
      <WorkspaceSection />
      <ComputersSection />
      <YourDataSection />
    </div>
  );
}

function WorkspaceSection() {
  const t = useTranslations('capture');
  const qc = useQueryClient();
  const { accountId, account, isManager, isOwner, settings } = useCaptureAccount();
  const data = settings.data;
  const [days, setDays] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: Parameters<typeof updateCaptureSettings>[1]) =>
      updateCaptureSettings(accountId!, input),
    onSuccess: (next) => {
      qc.setQueryData(captureKeys.settings(accountId!), next);
      qc.invalidateQueries({ queryKey: captureKeys.devices });
      setDays(null);
    },
    onError: (e: Error) => errorToast(e.message || t('saveFailed')),
  });

  if (!accountId || !data) {
    return (
      <section className="space-y-3">
        <SettingsSubsectionHeader title={t('workspaceTitle')} />
        <Skeleton className="h-40 rounded-md" />
      </section>
    );
  }

  const retention = days ?? String(data.retention_days);
  const commitRetention = () => {
    const n = Number(retention);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      errorToast(t('retentionInvalid'));
      setDays(null);
      return;
    }
    if (n !== data.retention_days) save.mutate({ retention_days: n });
    else setDays(null);
  };

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={t('workspaceTitle')} description={account?.name} />
      <SettingsRowGroup>
        <SettingsRow label={t('enableLabel')} description={t('enableDescription')}>
          {isManager ? (
            <Switch
              aria-label={t('enableLabel')}
              checked={data.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) => save.mutate({ enabled })}
            />
          ) : (
            <span className="text-muted-foreground text-sm">
              {data.enabled ? t('on') : t('off')}
            </span>
          )}
        </SettingsRow>
        <SettingsRow label={t('retentionLabel')} description={t('retentionDescription')}>
          {isManager ? (
            <>
              <Input
                type="number"
                min={1}
                max={3650}
                inputMode="numeric"
                aria-label={t('retentionLabel')}
                className="h-8 w-20 text-right"
                value={retention}
                disabled={save.isPending}
                onChange={(e) => setDays(e.target.value)}
                onBlur={commitRetention}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <span className="text-muted-foreground text-sm">{t('days')}</span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">
              {t('daysValue', { count: data.retention_days })}
            </span>
          )}
        </SettingsRow>
        <SettingsRow
          label={isManager ? t('adminsLabel') : t('adminsLabelMember')}
          description={isOwner || !isManager ? t('adminsDescription') : t('adminsOwnerOnly')}
        >
          {isManager ? (
            <Switch
              aria-label={t('adminsLabel')}
              checked={data.admins_can_view}
              disabled={!isOwner || save.isPending}
              onCheckedChange={(admins_can_view) => save.mutate({ admins_can_view })}
            />
          ) : (
            <span className="text-muted-foreground text-sm">
              {data.admins_can_view ? t('adminsCanView') : t('adminsCannotView')}
            </span>
          )}
        </SettingsRow>
      </SettingsRowGroup>
    </section>
  );
}

function ComputersSection() {
  const t = useTranslations('capture');
  const devices = useCaptureDevices();
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('computersTitle')}
        description={t('computersDescription')}
      />
      <SettingsRowGroup>
        <ThisComputer />
        {devices.isLoading ? (
          <div className="p-4">
            <Loading className="size-4" />
          </div>
        ) : (devices.data ?? []).length === 0 ? (
          <SettingsRow label={t('noDevices')} description={t('noDevicesHint')} />
        ) : (
          devices.data!.map((device) => <DeviceRow key={device.id} device={device} />)
        )}
      </SettingsRowGroup>
    </section>
  );
}

function DeviceRow({ device }: { device: CaptureDevice }) {
  const t = useTranslations('capture');
  const locale = useLocale();
  const qc = useQueryClient();
  const { accounts } = useCaptureAccount();
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateCaptureDevice>[1]) =>
      updateCaptureDevice(device.id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: captureKeys.devices }),
    onError: (e: Error) => errorToast(e.message || t('saveFailed')),
  });
  const status = deviceStatus(device);
  const statusText =
    status === 'paused'
      ? t('statusPaused', { time: formatWhen(device.paused_until!, locale) })
      : t(
          (
            {
              recording: 'statusRecording',
              off: 'statusOff',
              workspace_off: 'statusWorkspaceOff',
            } as const
          )[status] as never,
        );
  const last = device.last_upload_at
    ? t('lastUpload', { time: formatWhen(device.last_upload_at, locale) })
    : device.last_seen_at
      ? t('lastSeen', { time: formatWhen(device.last_seen_at, locale) })
      : t('neverUploaded');
  return (
    <SettingsRow label={device.name} description={`${statusText} · ${last}`}>
      <Select
        value={device.account_id}
        onValueChange={(account_id) => update.mutate({ account_id })}
        disabled={update.isPending}
      >
        <SelectTrigger aria-label={t('recordsInto')} className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.account_id} value={a.account_id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Switch
        aria-label={t('deviceSwitch', { name: device.name })}
        checked={device.enabled}
        disabled={update.isPending}
        onCheckedChange={(enabled) => update.mutate({ enabled })}
      />
    </SettingsRow>
  );
}

function YourDataSection() {
  const t = useTranslations('capture');
  const { accountId } = useCaptureAccount();
  const qc = useQueryClient();
  const today = localDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [confirm, setConfirm] = useState(false);
  const valid = from !== '' && to !== '' && from <= to;
  const remove = useMutation({
    mutationFn: () =>
      deleteCaptureData(accountId!, { from: dayBounds(from).from, to: dayBounds(to).to }),
    onSuccess: ({ deleted_chunks }) => {
      successToast(t('deleted', { count: deleted_chunks }));
      qc.invalidateQueries({ queryKey: captureKeys.all });
      setConfirm(false);
    },
    onError: (e: Error) => {
      errorToast(e.message || t('saveFailed'));
      setConfirm(false);
    },
  });
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={t('yourDataTitle')} description={t('yourDataDescription')} />
      <SettingsRowGroup>
        <SettingsRow label={t('deleteRange')}>
          <Input
            type="date"
            aria-label={t('from')}
            className="h-8 w-36"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            type="date"
            aria-label={t('to')}
            className="h-8 w-36"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={!valid || !accountId}
            onClick={() => setConfirm(true)}
          >
            {t('deleteCaptures')}
          </Button>
        </SettingsRow>
      </SettingsRowGroup>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirmDescription', { from, to })}
        confirmLabel={t('deleteCaptures')}
        onConfirm={() => remove.mutate()}
        isPending={remove.isPending}
        confirmVariant="destructive"
      />
    </section>
  );
}
