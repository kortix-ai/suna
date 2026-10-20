'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Modal, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { PdfRenderer } from '@/features/file-renderers/pdf/pdf-renderer';
import { getFileCategory } from '@/features/file-viewer/preview-policy';
import { useTranslations } from '@/i18n/use-translations';
import { downloadBlob } from '@/lib/utils/download';
import { useEffect, useState } from 'react';
import { PastedTextBody } from './pasted-text';

/** Stored attachments have their own bytes, not a path in a running sandbox. */
export function AttachmentPreview({
  name,
  mime,
  load,
  onClose,
}: {
  name: string;
  mime: string;
  load: () => Promise<Blob>;
  onClose: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const category = getFileCategory(name, mime);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    void load()
      .then(async (bytes) => {
        const content = category === 'pdf' ? null : await bytes.text();
        if (cancelled) return;
        setBlob(bytes);
        setText(content);
        if (category === 'pdf') {
          objectUrl = URL.createObjectURL(bytes);
          setUrl(objectUrl);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [load, category]);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-h-[85svh] flex-col overflow-hidden lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>{name}</ModalTitle>
        </ModalHeader>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          {error ? (
            <p role="alert">{error}</p>
          ) : !blob ? (
            <Loading />
          ) : category === 'pdf' ? (
            <div className="h-[65svh]">
              <PdfRenderer url={url} fileName={name} showDownload={false} />
            </div>
          ) : (
            <PastedTextBody text={text ?? ''} />
          )}
        </div>
        <div className="px-5 pb-5">
          <Button
            aria-label={t.raw('textd6eafe823591')}
            disabled={!blob}
            onClick={() => blob && downloadBlob(blob, name)}
          >
            {t.raw('textd6eafe823591')}
          </Button>
        </div>
      </ModalContent>
    </Modal>
  );
}
