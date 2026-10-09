'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@/lib/relative-time';
import type { App, AppSnapshot } from '@kortix/sdk';
import { useAppSnapshots, useProjectApps } from '@kortix/sdk/react';
import { useState } from 'react';

/**
 * Limits the API enforces on a resize of an App that runs its own machine
 * (`BACKEND_MACHINE_LIMITS`, apps/api/src/apps/kinds/convex/provision.ts). The
 * disk minimum rises to the current disk: a disk never shrinks.
 */
export const INSTANCE_SIZE_LIMITS = {
  cpu: { min: 1, max: 16 },
  memory_gb: { min: 1, max: 32 },
  disk_gb: { min: 10, max: 100 },
} as const;

type SizeKey = keyof typeof INSTANCE_SIZE_LIMITS;
const SIZE_KEYS: SizeKey[] = ['cpu', 'memory_gb', 'disk_gb'];

export type SizeDraft = Record<SizeKey, string>;
type MachineSize = App['machine'];

export function sizeDraft(current: MachineSize): SizeDraft {
  return {
    cpu: String(current.cpu),
    memory_gb: String(current.memory_gb),
    disk_gb: String(current.disk_gb),
  };
}

/** The lowest value a field accepts. A disk never shrinks, so its minimum is the current disk. */
export function sizeMin(key: SizeKey, current: MachineSize): number {
  return key === 'disk_gb'
    ? Math.max(INSTANCE_SIZE_LIMITS.disk_gb.min, current.disk_gb)
    : INSTANCE_SIZE_LIMITS[key].min;
}

/** True when `raw` is a whole number inside the field's limits. */
export function sizeFieldValid(key: SizeKey, raw: string, current: MachineSize): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const value = Number(raw);
  return value >= sizeMin(key, current) && value <= INSTANCE_SIZE_LIMITS[key].max;
}

/** Only the fields that differ from the current size. The API answers `size_unchanged` for an empty change. */
export function sizeChanges(draft: SizeDraft, current: MachineSize): Partial<MachineSize> {
  const out: Partial<MachineSize> = {};
  for (const key of SIZE_KEYS) if (Number(draft[key]) !== current[key]) out[key] = Number(draft[key]);
  return out;
}

export function formatBackupSize(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** A future time as "in 6 days" in the viewer's locale; null once it has passed. */
export function timeUntil(iso: string, now = Date.now()): string | null {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'narrow' });
  if (minutes < 60) return format.format(minutes, 'minute');
  if (minutes < 48 * 60) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}

/** Manual snapshots count against the limit; daily and resize snapshots do not. */
export function manualSnapshotCount(snapshots: Pick<AppSnapshot, 'kind'>[]): number {
  return snapshots.filter((snapshot) => snapshot.kind === 'manual').length;
}

/** Turns a resize, snapshot, restore or rotation API error into a sentence. */
export function instanceOperationError(error: unknown, fallback: string, t: UiTranslator): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'size_unchanged':
      return t.raw('texte80235a54789');
    case 'disk_shrink_unsupported':
      return t.raw('text19505ae1c4fa');
    case 'invalid_size':
      return t.raw('text97b11693daf1');
    case 'app_busy':
      return t.raw('textdffa6c4832ea');
    case 'app_not_running':
      return t.raw('text82d8fd7be760');
    case 'snapshot_not_found':
      return t.raw('text9d850085f763');
    case 'snapshot_limit':
      return t.raw('text66a50145812d');
    case 'snapshot_predates_resize':
      return t.raw('text71f6cc5e959a');
    case 'restore_unhealthy':
      return t.raw('text0ea70cfac481');
    default:
      return error instanceof Error ? error.message : fallback;
  }
}


/** Resize an App that runs its own machine: `PATCH /apps/:appId` with the changed fields; the machine restarts on the new size. */
export function ResizeAppDialog({
  projectId,
  app,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const apps = useProjectApps(projectId);
  const current = app.machine;
  const isPending = apps.update.isPending;
  const [draft, setDraft] = useState<SizeDraft>(() => sizeDraft(current));
  const [apiError, setApiError] = useState<string | null>(null);
  const valid = SIZE_KEYS.every((key) => sizeFieldValid(key, draft[key], current));
  const changes = sizeChanges(draft, current);
  const changed = Object.keys(changes).length > 0;

  const fields: Array<{ key: SizeKey; label: string }> = [
    { key: 'cpu', label: t.raw('textd0a4f1baaeab') },
    { key: 'memory_gb', label: t.raw('text94b205cadab5') },
    { key: 'disk_gb', label: t.raw('textcce9286fec89') },
  ];

  const submit = async () => {
    if (!valid || !changed || isPending) return;
    setApiError(null);
    try {
      await apps.update.mutateAsync({ appId: app.app_id, input: changes });
      successToast(t.raw('textb31af9a5b37a'));
      onOpenChange(false);
    } catch (error) {
      setApiError(instanceOperationError(error, t.raw('textdf1c5a2018d4'), t));
    }
  };

  return (
    <Modal open onOpenChange={(open) => !isPending && onOpenChange(open)}>
      <ModalContent className="lg:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <ModalHeader>
            <ModalTitle>{t('texta507e087427a', { value0: app.name })}</ModalTitle>
            <ModalDescription>{t.raw('text0ddcdc542ef9')}</ModalDescription>
          </ModalHeader>
          <ModalBody>
            <div className="grid grid-cols-3 gap-3">
              {fields.map(({ key, label }) => {
                const invalid = !sizeFieldValid(key, draft[key], current);
                return (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`app-size-${key}`}>{label}</Label>
                    <Input
                      id={`app-size-${key}`}
                      type="number"
                      inputMode="numeric"
                      min={sizeMin(key, current)}
                      max={INSTANCE_SIZE_LIMITS[key].max}
                      step={1}
                      value={draft[key]}
                      onChange={(event) => {
                        setDraft((value) => ({ ...value, [key]: event.target.value }));
                        setApiError(null);
                      }}
                      aria-invalid={invalid}
                    />
                    <p className={invalid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                      {t('text6dd8cdbf8352', {
                        value0: sizeMin(key, current),
                        value1: INSTANCE_SIZE_LIMITS[key].max,
                      })}
                    </p>
                  </div>
                );
              })}
            </div>
            {apiError ? (
              <p className="text-destructive mt-3 text-xs" role="alert">
                {apiError}
              </p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              {t.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!valid || !changed || isPending}>
              {isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t.raw('text2956e06ac065')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/** Snapshots of an App (capability `snapshots`): the automatic backup, the list, take, delete and restore (capability `restore`). */
export function AppSnapshotsDialog({
  projectId,
  app,
  canWrite,
  canRestore,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canRestore: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const snapshots = useAppSnapshots(projectId, app.app_id);
  const [pendingRestore, setPendingRestore] = useState<AppSnapshot | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppSnapshot | null>(null);
  const busy = Boolean(app.instance?.operation);
  const restoring = snapshots.restore.isPending;
  const automatic = snapshots.data?.automatic;
  const schedule = snapshots.data?.snapshot_schedule;
  const limit = snapshots.data?.snapshot_limit;
  const atLimit = limit !== undefined && manualSnapshotCount(snapshots.data?.snapshots ?? []) >= limit;
  const kindLabel = (kind: AppSnapshot['kind']) =>
    kind === 'automatic'
      ? t.raw('textb36c2611dcdf')
      : kind === 'resize'
        ? t.raw('text819a1788de99')
        : kind === 'final'
          ? t.raw('textf4ed8fa656b7')
          : t.raw('textb0b9fe24ffa9');
  const expiryLabel = (snapshot: AppSnapshot) => {
    if (!snapshot.expires_at) return t.raw('textbee3b293c9f6');
    const left = timeUntil(snapshot.expires_at);
    if (left) return t('text8c3e7e71155c', { value0: left });
    // The newest daily snapshot outlives its expiry until a newer one exists.
    return snapshot.kind === 'automatic' ? t.raw('text68f1baa5d324') : t.raw('text424a2551d356');
  };

  const takeSnapshot = async () => {
    try {
      await snapshots.create.mutateAsync();
      successToast(t.raw('text9a2de8b2728e'));
    } catch (error) {
      errorToast(instanceOperationError(error, t.raw('text3c7a3332a5a8'), t));
    }
  };

  return (
    <>
      <Modal open onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{t('text8103f212aba8', { value0: app.name })}</ModalTitle>
            <ModalDescription>{t.raw('text38d61e78c348')}</ModalDescription>
          </ModalHeader>
          <ModalBody>
            {snapshots.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ) : snapshots.isError ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-destructive text-sm" role="alert">
                  {instanceOperationError(snapshots.error, t.raw('text7a306da87381'), t)}
                </p>
                <Button size="sm" variant="outline" onClick={() => snapshots.refetch()}>
                  {t.raw('text942087cc2d41')}
                </Button>
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-1" data-testid="app-automatic-backup">
                  <Label>{t.raw('text3dadeedf4c21')}</Label>
                  <p className="text-muted-foreground text-sm">
                    {automatic?.last_backup_at
                      ? t('text5efa68d158fe', {
                          value0: relativeTime(automatic.last_backup_at),
                          value1: formatBackupSize(automatic.size_bytes),
                        })
                      : t.raw('text10f051360895')}
                    {automatic?.interval_minutes
                      ? ` · ${t('text743f2a7e24f3', { value0: automatic.interval_minutes })}`
                      : ''}
                  </p>
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>{t.raw('textf187f78e07ef')}</Label>
                    {canWrite ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || atLimit || snapshots.create.isPending}
                        onClick={() => void takeSnapshot()}
                      >
                        {snapshots.create.isPending ? <Loading className="size-4 shrink-0" /> : null}
                        {t.raw('text2c86d50742a1')}
                      </Button>
                    ) : null}
                  </div>
                  {snapshots.data?.snapshots.length ? (
                    <ul className="space-y-2" data-testid="app-snapshots">
                      {snapshots.data.snapshots.map((snapshot) => (
                        <li
                          key={snapshot.snapshot_id}
                          className="bg-popover border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                        >
                          <span className="min-w-0 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-mono text-xs">{snapshot.snapshot_id}</span>
                              <Badge variant="outline" size="sm" data-testid="app-snapshot-kind">
                                {kindLabel(snapshot.kind)}
                              </Badge>
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {relativeTime(snapshot.created_at)} · {formatBackupSize(snapshot.size_bytes)} ·{' '}
                              {expiryLabel(snapshot)}
                            </span>
                          </span>
                          {canWrite || canRestore ? (
                            <span className="flex shrink-0 items-center gap-1">
                              {canWrite ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy || restoring || snapshots.delete.isPending}
                                  onClick={() => setPendingDelete(snapshot)}
                                >
                                  {t.raw('texte2d0a54968ea')}
                                </Button>
                              ) : null}
                              {canRestore ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy || restoring}
                                  onClick={() => setPendingRestore(snapshot)}
                                >
                                  {t.raw('texta76e13b98392')}
                                </Button>
                              ) : null}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-sm">{t.raw('textdce32a8bd22e')}</p>
                  )}
                  {schedule && limit !== undefined ? (
                    <p className="text-muted-foreground text-xs" data-testid="app-snapshot-schedule">
                      {t('textcac5e168fd53', {
                        value0: schedule.automatic_interval_hours,
                        value1: schedule.automatic_retention_days,
                        value2: schedule.resize_retention_hours,
                        value3: limit,
                      })}
                    </p>
                  ) : null}
                </section>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.raw('text7d9eb7acb13e')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => !open && !restoring && setPendingRestore(null)}
        title={t.raw('text4f9edcd9f991')}
        description={t('text459953ec0256', {
          value0: app.name,
          value1: pendingRestore ? relativeTime(pendingRestore.created_at) : '',
        })}
        confirmLabel={t.raw('texta76e13b98392')}
        confirmVariant="destructive"
        isPending={restoring}
        onConfirm={async () => {
          if (!pendingRestore) return;
          try {
            await snapshots.restore.mutateAsync(pendingRestore.snapshot_id);
            successToast(t.raw('text50f89377e008'));
          } catch (error) {
            errorToast(instanceOperationError(error, t.raw('textc7749399019b'), t));
          }
          setPendingRestore(null);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !snapshots.delete.isPending && setPendingDelete(null)}
        title={t.raw('text6f70f5ac2047')}
        description={t('textc2ee618713fb', {
          value0: app.name,
          value1: pendingDelete ? relativeTime(pendingDelete.created_at) : '',
        })}
        confirmLabel={t.raw('textab50f27cec49')}
        confirmVariant="destructive"
        isPending={snapshots.delete.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await snapshots.delete.mutateAsync(pendingDelete.snapshot_id);
            successToast(t.raw('textedc63daf62bc'));
          } catch (error) {
            errorToast(instanceOperationError(error, t.raw('text4ac5e5c981cc'), t));
          }
          setPendingDelete(null);
        }}
      />
    </>
  );
}
