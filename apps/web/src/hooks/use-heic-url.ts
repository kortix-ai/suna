'use client';

import { convertHeicBlobToJpeg, isHeicFile } from '@/lib/utils/heic-convert';
import { useEffect, useState } from 'react';

/**
 * Converts a HEIC blob to a renderable JPEG blob URL.
 * Non-HEIC blobs get a plain blob URL (passthrough, no conversion).
 */
export function useHeicBlob(
  blob: Blob | null,
  fileName: string,
): { url: string | null; isConverting: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const needsConversion = isHeicFile(fileName);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }

    if (!needsConversion) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setIsConverting(true);
    convertHeicBlobToJpeg(blob)
      .then((jpeg) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(jpeg);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .finally(() => {
        if (!cancelled) setIsConverting(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blob, needsConversion]);

  return { url, isConverting };
}
