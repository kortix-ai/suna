'use client';

import type { CaptureExportInput } from '@kortix/sdk';
import { useCaptureExport, useCreateCaptureExport } from '@kortix/sdk/react';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';

type Part = NonNullable<CaptureExportInput['include']>[number];
const PARTS: readonly Part[] = ['episodes', 'steps', 'workflows'];

/**
 * Export data: episodes, steps and workflows of the header's date range as
 * JSONL or Parquet (Capture admins). The export runs on the server; the modal
 * polls it and offers the signed download once it is done.
 */
export function ExportModal({
  accountId,
  open,
  onOpenChange,
  window,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  window: { from: string; to: string };
}) {
  const t = useTranslations('capture.export');
  const locale = useLocale();
  const [format, setFormat] = useState<CaptureExportInput['format']>('jsonl');
  const [include, setInclude] = useState<Part[]>([...PARTS]);
  const create = useCreateCaptureExport(accountId);
  const [exportId, setExportId] = useState<string | null>(null);
  const job = useCaptureExport(accountId, exportId);
  const status = job.data?.status ?? (create.isPending ? 'queued' : null);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setExportId(null);
      create.reset();
    }
  };
  const start = () =>
    create.mutate(
      { format, include, from: window.from, to: window.to },
      {
        onSuccess: (created) => setExportId(created.export_id),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('failed')),
      },
    );
  const range = `${new Date(window.from).toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${new Date(Date.parse(window.to) - 1).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description', { range })}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-5">
          <Field>
            <FieldLabel>{t('format')}</FieldLabel>
            <Tabs
              value={format}
              onValueChange={(value) => setFormat(value as CaptureExportInput['format'])}
            >
              <TabsList aria-label={t('format')}>
                <TabsTrigger value="jsonl">{t('formatJsonl')}</TabsTrigger>
                <TabsTrigger value="parquet">{t('formatParquet')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-foreground mb-2 text-sm font-medium">{t('include')}</legend>
            {PARTS.map((part) => (
              <label key={part} className="flex items-center gap-2.5 text-sm">
                <Checkbox
                  checked={include.includes(part)}
                  onCheckedChange={(on) =>
                    setInclude((cur) => (on ? [...cur, part] : cur.filter((p) => p !== part)))
                  }
                />
                {t(`part.${part}`)}
              </label>
            ))}
          </fieldset>
          {status === 'failed' ? (
            <InfoBanner tone="destructive" title={t('failed')}>
              {job.data?.error ?? ''}
            </InfoBanner>
          ) : status === 'done' && job.data ? (
            <InfoBanner tone="success" title={t('ready', { rows: job.data.rows ?? 0 })}>
              {job.data.download ? null : t('empty')}
            </InfoBanner>
          ) : status ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
              <Loading className="size-4 shrink-0" />
              {t('running')}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={() => close(false)}>
            {t('close')}
          </Button>
          {status === 'done' && job.data?.download ? (
            <Button asChild className="gap-1.5">
              <a href={job.data.download.url} download>
                <DownloadSimpleIcon className="size-4 shrink-0" />
                {t('download')}
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              disabled={include.length === 0 || (status !== null && status !== 'failed')}
              onClick={start}
            >
              {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('start')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
