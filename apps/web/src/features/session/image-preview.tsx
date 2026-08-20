'use client';

import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useState } from 'react';

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
}

/**
 * ImagePreview — wraps a clickable image thumbnail. On click, opens a full-size
 * preview in the system `Modal` (feature code never reaches for `Dialog`).
 */
export function ImagePreview({ src, alt = 'Image preview', children }: ImagePreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="cursor-zoom-in" onClick={() => setOpen(true)}>
        {children}
      </button>

      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent
          variant="transparent"
          className="max-h-[90vh] space-y-0 border-none bg-black/95 p-2 lg:max-w-[90vw]"
          aria-describedby={undefined}
        >
          <VisuallyHidden>
            <ModalTitle>{alt}</ModalTitle>
          </VisuallyHidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="mx-auto max-h-[85vh] max-w-full rounded-md object-contain"
          />
        </ModalContent>
      </Modal>
    </>
  );
}
