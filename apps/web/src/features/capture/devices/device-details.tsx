'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { useCopy } from '@kortix/ui/internal/hooks/use-copy';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { diagnosticsText, formatBytes, versionView, type VersionState } from './device-diagnostics';
import { deviceStatus } from './device-status';
import { StatusLabel } from './device-status-ui';

/** The version and, when it matters, its update state: "0.14.19 · Update failed". */
export function VersionBadge({ device }: { device: CaptureDevice }) {
  const t = useTranslations('capture.devices');
  const view = versionView(device);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground tabular-nums">{view.version ?? t('never')}</span>
      <UpdateBadge state={view.state} only={['failed', 'behind', 'updating']} />
    </span>
  );
}

function UpdateBadge({ state, only }: { state: VersionState; only?: VersionState[] }) {
  const t = useTranslations('capture.devices');
  if (!state || (only && !only.includes(state))) return null;
  return (
    <Badge
      size="xs"
      variant={state === 'failed' ? 'destructive' : state === 'behind' || state === 'updating' ? 'warning' : 'outline'}
    >
      {t(`version.${state}`)}
    </Badge>
  );
}

/** One label and value. Literal values (versions, ids, builds) are mono. */
function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'text-foreground min-w-0 font-mono text-xs leading-5 break-words' : 'text-foreground min-w-0 break-words'}>
        {children}
      </dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">{children}</dl>
    </section>
  );
}

/**
 * Device details: what the computer reports to Kortix, in four sections
 * (Capture, Machine, Recording and sync, Policy), and one button that copies
 * all of it as plain text for a support request.
 */
export function DeviceDetailsModal({
  device,
  name,
  onClose,
}: {
  device: CaptureDevice | null;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('capture.devices.details');
  const tDevices = useTranslations('capture.devices');
  const locale = useLocale();
  const { copy, copied } = useCopy({ successMessage: t('copiedToast'), errorMessage: t('copyFailed') });
  const d = device?.diagnostics;
  const notReported = t('notReported');
  const when = (iso: string | null | undefined) =>
    iso ? (
      <time dateTime={iso} title={new Date(iso).toLocaleString(locale)}>
        {relativeTime(Date.parse(iso), locale)}
      </time>
    ) : (
      notReported
    );
  const text = (value: string | number | null | undefined) =>
    value === null || value === undefined || value === '' ? notReported : String(value);
  const version = device ? versionView(device) : null;
  const update = d?.update ?? null;
  const result = update?.last_result ?? null;
  const machine = d?.machine ?? null;

  return (
    <Modal open={device !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <ModalContent className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>{t('title', { name })}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        {device ? (
          <ModalBody className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
            <Section title={t('capture')}>
              <Row label={t('version')}>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs">{text(version?.version)}</span>
                  <UpdateBadge state={version?.state ?? null} />
                </span>
              </Row>
              <Row label={t('channel')}>{text(update?.channel)}</Row>
              {update?.latest ? (
                <Row label={t('latest')} mono>
                  {update.latest}
                </Row>
              ) : null}
              <Row label={t('lastCheck')}>{update ? when(update.last_check_at) : t('noUpdater')}</Row>
              {update?.last_check ? (
                <Row label={t('lastCheckSaid')} mono>
                  {update.last_check}
                </Row>
              ) : null}
              <Row label={t('lastResult')}>
                {result ? (
                  <span className="flex flex-col gap-0.5">
                    <span>{t(`outcome.${result.outcome === 'updated' || result.outcome === 'rolled_back' || result.outcome === 'failed' || result.outcome === 'install_failed' ? result.outcome : 'other'}`, { from: result.from ?? '?', to: result.to ?? '?' })}</span>
                    <span className="text-muted-foreground text-xs">{when(result.at)}</span>
                  </span>
                ) : (
                  t('none')
                )}
              </Row>
              {result?.detail ? (
                <Row label={t('reason')} mono>
                  {result.detail}
                </Row>
              ) : null}
              <Row label={t('skipped')}>
                {update?.skipped.length
                  ? update.skipped.map((s) => (
                      <span key={s.version} className="block">
                        {s.retry_at
                          ? t('skippedUntil', { version: s.version, time: new Date(s.retry_at).toLocaleDateString(locale) })
                          : s.version}
                      </span>
                    ))
                  : t('none')}
              </Row>
            </Section>

            <Section title={t('machine')}>
              <Row label={t('os')}>{text(d?.os.name)}</Row>
              <Row label={t('build')} mono>
                {[d?.os.build ?? d?.os.version, d?.os.arch ?? device.arch].filter(Boolean).join(' · ') || notReported}
              </Row>
              {d?.hostname ? (
                <Row label={t('hostname')} mono>
                  {d.hostname}
                </Row>
              ) : null}
              <Row label={t('cpu')}>
                {machine?.cpu
                  ? machine.cpu_cores
                    ? t('cpuCores', { cpu: machine.cpu, count: machine.cpu_cores })
                    : machine.cpu
                  : notReported}
              </Row>
              <Row label={t('memory')}>{text(formatBytes(machine?.memory_bytes))}</Row>
              <Row label={t('disk')}>
                {machine?.disk_free_bytes != null && machine.disk_total_bytes != null
                  ? t('diskOf', { free: formatBytes(machine.disk_free_bytes) ?? '', total: formatBytes(machine.disk_total_bytes) ?? '' })
                  : notReported}
              </Row>
              {machine?.gpus.length ? <Row label={t('gpus')}>{machine.gpus.join(', ')}</Row> : null}
              <Row label={t('booted')}>{when(machine?.booted_at)}</Row>
              <Row label={t('timezone')}>
                {machine?.timezone ? `${machine.timezone}${machine.utc_offset ? ` (${machine.utc_offset})` : ''}` : notReported}
              </Row>
              <Row label={t('locale')}>{text(machine?.locale)}</Row>
            </Section>

            <Section title={t('recordingSync')}>
              <Row label={t('status')}>
                <StatusLabel view={deviceStatus(device)} />
              </Row>
              {d?.recording.last_error ? (
                <Row label={t('recordingError')} mono>
                  {d.recording.last_error}
                </Row>
              ) : null}
              <Row label={t('lastFrame')}>{when(d?.recording.last_frame_at)}</Row>
              {d?.recording.missing_permissions.length ? (
                <Row label={t('permissions')}>
                  {d.recording.missing_permissions
                    .map((p) =>
                      ['screen_recording', 'accessibility', 'microphone'].includes(p) ? tDevices(`permission.${p}`) : p,
                    )
                    .join(', ')}
                </Row>
              ) : null}
              <Row label={t('sync')}>
                {d?.sync.state ? t(`syncState.${['ok', 'queued', 'error', 'off'].includes(d.sync.state) ? d.sync.state : 'other'}`, { count: d.sync.pending ?? 0 }) : notReported}
              </Row>
              {d?.sync.error_class ? (
                <Row label={t('syncError')} mono>
                  {d.sync.error_class}
                </Row>
              ) : null}
              <Row label={t('lastUpload')}>{when(d?.sync.last_upload_at)}</Row>
              <Row label={t('reported')}>{when(d?.reported_at ?? device.live.reported_at)}</Row>
            </Section>

            <Section title={t('policy')}>
              <Row label={t('policySource')}>
                {d?.policy?.source ? <span className="font-mono text-xs break-words">{d.policy.source}</span> : t('noPolicy')}
              </Row>
              {d?.policy ? <Row label={t('policyRead')}>{when(d.policy.fetched_at)}</Row> : null}
              <Row label={t('enrolled')}>{d?.managed || device.enrollment_token_id ? t('managed') : t('personal')}</Row>
              <Row label={t('encrypted')}>{d?.encrypted ? t('yes') : t('no')}</Row>
              <Row label={t('lastCredentials')}>{when(d?.last_credentials_at ?? device.last_credentials_at)}</Row>
              <Row label={t('deviceId')} mono>
                {device.device_id}
              </Row>
            </Section>
          </ModalBody>
        ) : null}
        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
          <Button size="sm" className="gap-1.5" disabled={!device} onClick={() => device && copy(diagnosticsText(device, name))}>
            {copied ? <CheckIcon className="text-kortix-green size-3.5 shrink-0" /> : <CopyIcon className="size-3.5 shrink-0" />}
            {copied ? t('copied') : t('copy')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
