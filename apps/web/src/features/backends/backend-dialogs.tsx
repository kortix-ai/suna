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
import type { ProjectBackend, ProjectBackendSize, ProjectBackendSnapshot } from '@kortix/sdk';
import { useProjectBackendBackups } from '@kortix/sdk/react';
import { useState } from 'react';

/** Limits the API enforces on `POST` and `PATCH /backends`. The disk minimum rises to the current disk on resize. */
export const BACKEND_SIZE_LIMITS = {
  cpu: { min: 1, max: 16 },
  memory_gb: { min: 1, max: 32 },
  disk_gb: { min: 10, max: 100 },
} as const;

type SizeKey = keyof typeof BACKEND_SIZE_LIMITS;
const SIZE_KEYS: SizeKey[] = ['cpu', 'memory_gb', 'disk_gb'];

export type SizeDraft = Record<SizeKey, string>;

export function sizeDraft(backend: Pick<ProjectBackend, SizeKey>): SizeDraft {
  return {
    cpu: String(backend.cpu),
    memory_gb: String(backend.memory_gb),
    disk_gb: String(backend.disk_gb),
  };
}

/** The lowest value a field accepts. A disk never shrinks, so its minimum is the current disk. */
export function sizeMin(key: SizeKey, current: Pick<ProjectBackend, SizeKey>): number {
  return key === 'disk_gb'
    ? Math.max(BACKEND_SIZE_LIMITS.disk_gb.min, current.disk_gb)
    : BACKEND_SIZE_LIMITS[key].min;
}

/** True when `raw` is a whole number inside the field's limits. */
export function sizeFieldValid(key: SizeKey, raw: string, current: Pick<ProjectBackend, SizeKey>): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const value = Number(raw);
  return value >= sizeMin(key, current) && value <= BACKEND_SIZE_LIMITS[key].max;
}

/** Only the fields that differ from the current size. The API answers `size_unchanged` for an empty change. */
export function sizeChanges(draft: SizeDraft, current: Pick<ProjectBackend, SizeKey>): ProjectBackendSize {
  const out: ProjectBackendSize = {};
  for (const key of SIZE_KEYS) if (Number(draft[key]) !== current[key]) out[key] = Number(draft[key]);
  return out;
}

export function backendSizeLabel(backend: Pick<ProjectBackend, SizeKey>, t: UiTranslator): string {
  return t('textce0eabb01151', {
    value0: backend.cpu,
    value1: backend.memory_gb,
    value2: backend.disk_gb,
  });
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
export function manualSnapshotCount(snapshots: Pick<ProjectBackendSnapshot, 'kind'>[]): number {
  return snapshots.filter((snapshot) => (snapshot.kind ?? 'manual') === 'manual').length;
}

/** Turns a resize, snapshot or restore API error into a sentence. */
export function backendOperationError(error: unknown, fallback: string, t: UiTranslator): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'size_unchanged':
      return t.raw('texteeaf510d672b');
    case 'disk_shrink_unsupported':
      return t.raw('text19505ae1c4fa');
    case 'invalid_size':
      return t.raw('text97b11693daf1');
    case 'backend_busy':
      return t.raw('text2e51fa03b6a4');
    case 'backend_not_running':
      return t.raw('textc6223308cd3f');
    case 'snapshot_not_found':
      return t.raw('text9d850085f763');
    case 'snapshot_limit':
      return t.raw('text4e3a1dc4819c');
    case 'snapshot_predates_resize':
      return t.raw('text71f6cc5e959a');
    case 'restore_unhealthy':
      return t.raw('texte9d5195e7f19');
    default:
      return error instanceof Error ? error.message : fallback;
  }
}

export function ResizeBackendDialog({
  backend,
  onOpenChange,
  onResize,
  isPending,
}: {
  backend: ProjectBackend;
  onOpenChange: (open: boolean) => void;
  onResize: (size: ProjectBackendSize) => Promise<unknown>;
  isPending: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [draft, setDraft] = useState<SizeDraft>(() => sizeDraft(backend));
  const [apiError, setApiError] = useState<string | null>(null);
  const valid = SIZE_KEYS.every((key) => sizeFieldValid(key, draft[key], backend));
  const changes = sizeChanges(draft, backend);
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
      await onResize(changes);
      successToast(t.raw('textb31af9a5b37a'));
      onOpenChange(false);
    } catch (error) {
      setApiError(backendOperationError(error, t.raw('text808c404f1155'), t));
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
            <ModalTitle>{t('texta507e087427a', { value0: backend.name })}</ModalTitle>
            <ModalDescription>
              {t.raw('text3d07e752f837')}
            </ModalDescription>
          </ModalHeader>
          <ModalBody>
            <div className="grid grid-cols-3 gap-3">
              {fields.map(({ key, label }) => {
                const invalid = !sizeFieldValid(key, draft[key], backend);
                return (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`backend-${key}`}>{label}</Label>
                    <Input
                      id={`backend-${key}`}
                      type="number"
                      inputMode="numeric"
                      min={sizeMin(key, backend)}
                      max={BACKEND_SIZE_LIMITS[key].max}
                      step={1}
                      value={draft[key]}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, [key]: event.target.value }));
                        setApiError(null);
                      }}
                      aria-invalid={invalid}
                    />
                    <p className={invalid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                      {t('text6dd8cdbf8352', {
                        value0: sizeMin(key, backend),
                        value1: BACKEND_SIZE_LIMITS[key].max,
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

export function BackendBackupsDialog({
  projectId,
  backend,
  canWrite,
  onOpenChange,
  onRestore,
  restoring,
}: {
  projectId: string;
  backend: ProjectBackend;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (snapshotId: string) => Promise<unknown>;
  restoring: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const backups = useProjectBackendBackups(projectId, backend.backend_id);
  const [pendingRestore, setPendingRestore] = useState<{ snapshot_id: string; created_at: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ snapshot_id: string; created_at: string } | null>(null);
  const busy = backend.operation !== null;
  const automatic = backups.data?.automatic;
  const schedule = backups.data?.snapshot_schedule;
  const limit = backups.data?.snapshot_limit;
  const atLimit = limit !== undefined && manualSnapshotCount(backups.data?.snapshots ?? []) >= limit;
  const kindLabel = (kind: ProjectBackendSnapshot['kind']) =>
    kind === 'automatic'
      ? t.raw('textb36c2611dcdf')
      : kind === 'resize'
        ? t.raw('text819a1788de99')
        : t.raw('textb0b9fe24ffa9');
  const expiryLabel = (snapshot: ProjectBackendSnapshot) => {
    if (!snapshot.expires_at) return t.raw('textbee3b293c9f6');
    const left = timeUntil(snapshot.expires_at);
    if (left) return t('text8c3e7e71155c', { value0: left });
    // The newest daily snapshot outlives its expiry until a newer one exists.
    return snapshot.kind === 'automatic' ? t.raw('text68f1baa5d324') : t.raw('text424a2551d356');
  };

  const takeSnapshot = async () => {
    try {
      await backups.snapshot.mutateAsync();
      successToast(t.raw('text9a2de8b2728e'));
    } catch (error) {
      errorToast(backendOperationError(error, t.raw('text3c7a3332a5a8'), t));
    }
  };

  return (
    <>
      <Modal open onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{t('text8103f212aba8', { value0: backend.name })}</ModalTitle>
            <ModalDescription>
              {t.raw('texte01556a13803')}
            </ModalDescription>
          </ModalHeader>
          <ModalBody>
            {backups.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ) : backups.isError ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-destructive text-sm" role="alert">
                  {backendOperationError(backups.error, t.raw('text7a306da87381'), t)}
                </p>
                <Button size="sm" variant="outline" onClick={() => backups.refetch()}>
                  {t.raw('text942087cc2d41')}
                </Button>
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-1" data-testid="backend-automatic-backup">
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
                        disabled={busy || atLimit || backups.snapshot.isPending}
                        onClick={() => void takeSnapshot()}
                      >
                        {backups.snapshot.isPending ? <Loading className="size-4 shrink-0" /> : null}
                        {t.raw('text2c86d50742a1')}
                      </Button>
                    ) : null}
                  </div>
                  {backups.data?.snapshots.length ? (
                    <ul className="space-y-2" data-testid="backend-snapshots">
                      {backups.data.snapshots.map((snapshot) => (
                        <li
                          key={snapshot.snapshot_id}
                          className="bg-popover border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                        >
                          <span className="min-w-0 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-mono text-xs">{snapshot.snapshot_id}</span>
                              <Badge variant="outline" size="sm" data-testid="backend-snapshot-kind">
                                {kindLabel(snapshot.kind)}
                              </Badge>
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {relativeTime(snapshot.created_at)} · {formatBackupSize(snapshot.size_bytes)} ·{' '}
                              {expiryLabel(snapshot)}
                            </span>
                          </span>
                          {canWrite ? (
                            <span className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || restoring || backups.deleteSnapshot.isPending}
                                onClick={() => setPendingDelete(snapshot)}
                              >
                                {t.raw('texte2d0a54968ea')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy || restoring}
                                onClick={() => setPendingRestore(snapshot)}
                              >
                                {t.raw('texta76e13b98392')}
                              </Button>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-sm">{t.raw('textdce32a8bd22e')}</p>
                  )}
                  <p className="text-muted-foreground text-xs" data-testid="backend-snapshot-schedule">
                    {schedule && limit !== undefined
                      ? t('textcac5e168fd53', {
                          value0: schedule.automatic_interval_hours,
                          value1: schedule.automatic_retention_days,
                          value2: schedule.resize_retention_hours,
                          value3: limit,
                        })
                      : t.raw('text703e24c19684')}
                  </p>
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
          value0: backend.name,
          value1: pendingRestore ? relativeTime(pendingRestore.created_at) : '',
        })}
        confirmLabel={t.raw('texta76e13b98392')}
        confirmVariant="destructive"
        isPending={restoring}
        onConfirm={async () => {
          if (!pendingRestore) return;
          try {
            await onRestore(pendingRestore.snapshot_id);
            successToast(t.raw('textbd6c657bb3d5'));
            setPendingRestore(null);
          } catch (error) {
            errorToast(backendOperationError(error, t.raw('text8a59975b229b'), t));
            setPendingRestore(null);
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !backups.deleteSnapshot.isPending && setPendingDelete(null)}
        title={t.raw('text6f70f5ac2047')}
        description={t('textc2ee618713fb', {
          value0: backend.name,
          value1: pendingDelete ? relativeTime(pendingDelete.created_at) : '',
        })}
        confirmLabel={t.raw('textab50f27cec49')}
        confirmVariant="destructive"
        isPending={backups.deleteSnapshot.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await backups.deleteSnapshot.mutateAsync(pendingDelete.snapshot_id);
            successToast(t.raw('textedc63daf62bc'));
          } catch (error) {
            errorToast(backendOperationError(error, t.raw('text4ac5e5c981cc'), t));
          }
          setPendingDelete(null);
        }}
      />
    </>
  );
}

/** The badge for an operation in flight: resize, admin-key rotation, snapshot, restore, or a recovery Kortix runs. */
export function BackendOperationBadge({ operation }: { operation: NonNullable<ProjectBackend['operation']> }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const labels: Record<NonNullable<ProjectBackend['operation']>, string> = {
    resizing: t.raw('text6f2769b24c0f'),
    rotating_key: t.raw('text4a75e77ccc8d'),
    recovering: t.raw('text959bdc881c93'),
    snapshotting: t.raw('textcd08dcee6a87'),
    restoring: t.raw('text5a4918e0201c'),
  };
  const label = labels[operation];
  return (
    <Badge variant="warning" className="gap-1.5">
      <Loading className="size-3 shrink-0" />
      {label}
    </Badge>
  );
}
