'use client';

import { useSaveCaptureRange } from '@kortix/sdk/react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useCaptureAccountId } from '../use-capture-viewer';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** `HH:MM` on the local day of `dayStart` → epoch ms. */
const onDay = (dayStart: number, value: string) => {
  const [h, m] = value.split(':').map(Number);
  const d = new Date(dayStart);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
};

interface SaveRangeProps {
  projectId: string;
  onOpenChange: (open: boolean) => void;
  /** Local midnight of the day (ms). */
  dayStart: number;
  initial: { start: number; end: number };
  deviceId: string | null;
}

/** Save a span of your own day as a range; its pipelines start at once, then the range page opens. */
export function SaveRangeModal({ open, ...props }: SaveRangeProps & { open: boolean }) {
  const t = useTranslations('capture.saveRange');
  return (
    <Modal open={open} onOpenChange={props.onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        {/* Mounted with the content, so every open starts from the moment's span. */}
        <SaveRangeForm {...props} />
      </ModalContent>
    </Modal>
  );
}

function SaveRangeForm({ projectId, onOpenChange, dayStart, initial, deviceId }: SaveRangeProps) {
  const accountId = useCaptureAccountId(projectId);
  const t = useTranslations('capture.saveRange');
  const router = useRouter();
  const save = useSaveCaptureRange(accountId);
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState(() => hhmm(initial.start));
  const [to, setTo] = useState(() => hhmm(initial.end));
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const start = onDay(dayStart, from);
    const end = onDay(dayStart, to);
    if (!(end > start)) {
      setError(t('endBeforeStart'));
      return;
    }
    save.mutate(
      {
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(deviceId ? { device_id: deviceId } : {}),
      },
      {
        onSuccess: (range) => {
          successToast(t('saved'));
          onOpenChange(false);
          router.push(`/projects/${projectId}/capture/ranges/${range.range_id}`);
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : t('failed')),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <ModalBody className="space-y-4">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="capture-range-title">{t('name')}</FieldLabel>
            <Input
              id="capture-range-title"
              value={title}
              maxLength={200}
              placeholder={t('namePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="capture-range-from">{t('from')}</FieldLabel>
              <Input
                id="capture-range-from"
                type="time"
                required
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="capture-range-to">{t('to')}</FieldLabel>
              <Input
                id="capture-range-to"
                type="time"
                required
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
        </FieldGroup>
        {error ? (
          <p role="alert" className="text-destructive text-xs wrap-anywhere">
            {error}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>
          {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {t('submit')}
        </Button>
      </ModalFooter>
    </form>
  );
}
