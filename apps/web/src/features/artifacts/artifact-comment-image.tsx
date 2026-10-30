'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useArtifactCommentScreenshot } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { useEffect, useState } from 'react';

export function ArtifactCommentImage({ image }: { image: Blob | undefined }) {
  const t = useTranslations('artifacts.discussion');
  const [url, setUrl] = useState<{ image: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!image) return;
    const next = URL.createObjectURL(image);
    setUrl({ image, url: next });
    return () => URL.revokeObjectURL(next);
  }, [image]);
  const src = url?.image === image ? url?.url : undefined;
  if (!src) return null;
  return (
    <Modal>
      <ModalTrigger asChild>
        <button
          type="button"
          aria-label={t('openScreenshot')}
          className="focus-visible:ring-ring border-border block max-w-full overflow-hidden rounded-md border focus-visible:ring-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t('drawingScreenshot')}
            className="max-h-40 max-w-full object-contain"
          />
        </button>
      </ModalTrigger>
      <ModalContent className="lg:max-w-4xl">
        <ModalHeader>
          <ModalTitle>{t('drawingScreenshot')}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t('drawingScreenshot')}
            className="max-h-[75dvh] w-full object-contain"
          />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export function SavedArtifactCommentImage({
  projectId,
  artifactId,
  commentId,
}: {
  projectId: string;
  artifactId: string;
  commentId: string;
}) {
  const t = useTranslations('artifacts.discussion');
  const image = useArtifactCommentScreenshot(projectId, artifactId, commentId);
  if (image.isLoading) return <Loading className="size-3" />;
  if (image.isError)
    return (
      <ErrorState
        size="sm"
        title={t('screenshotReadFailed')}
        action={
          <Button variant="ghost" size="xs" onClick={() => void image.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  return <ArtifactCommentImage image={image.data} />;
}
