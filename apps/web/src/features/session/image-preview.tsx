'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
}

/**
 * ImagePreview — wraps a clickable image thumbnail. On click, opens a full-size
 * preview dialog matching the SolidJS `ImagePreview` component.
 */
export function ImagePreview({ src, alt = 'Image preview', children }: ImagePreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="cursor-zoom-in"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 bg-black/95 border-none">
          <VisuallyHidden>
            <DialogTitle>{alt}</DialogTitle>
          </VisuallyHidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-[85vh] object-contain mx-auto rounded"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
