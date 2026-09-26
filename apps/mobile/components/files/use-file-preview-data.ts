/**
 * useFilePreviewData — loads what `FilePreview` needs for one sandbox file.
 * Shared by `FileViewer` (full screen) and the session's file preview sheet, so
 * the load rules live in one place:
 *
 * - text types load as text, image / PDF / DOCX load as a blob; spreadsheets
 *   and archives show a download prompt, so their bytes are never loaded
 * - a file over the preview limits (`previewDecision`) is not fetched, and a
 *   fetched blob over the limit is never converted: the data URL is a second,
 *   larger copy in JS
 */
import { useEffect, useState } from 'react';

import type { SandboxFile } from '@/api/types';
import { blobToDataURL, useOpenCodeFileBlob, useOpenCodeFileContent } from '@/lib/files/hooks';
import { previewDecision } from '@/lib/files/preview-limits';
import { FilePreviewType, getFilePreviewType } from './FilePreviewRenderers';

export interface FilePreviewDataOptions {
  /**
   * `false`: nothing is fetched. The session's file preview sheet passes it for
   * a file it does not render (a PDF, an Office file, an archive, media).
   */
  enabled?: boolean;
}

export function useFilePreviewData(
  file: SandboxFile | null,
  sandboxUrl: string | undefined,
  { enabled = true }: FilePreviewDataOptions = {}
) {
  const [blobUrl, setBlobUrl] = useState<string | undefined>();

  const previewType = file ? getFilePreviewType(file.name) : FilePreviewType.OTHER;
  // Binary file types that should be fetched as blob, not text
  const isBinaryFile =
    previewType === FilePreviewType.IMAGE ||
    previewType === FilePreviewType.PDF ||
    previewType === FilePreviewType.XLSX ||
    previewType === FilePreviewType.DOCX ||
    previewType === FilePreviewType.BINARY;
  // Size from the directory listing, when it reports one.
  const listingDecision = file ? previewDecision({ size: file.size, previewType }) : 'preview';
  const rendersBlob =
    previewType === FilePreviewType.IMAGE ||
    previewType === FilePreviewType.PDF ||
    previewType === FilePreviewType.DOCX;
  const shouldFetchText = enabled && !!file && !isBinaryFile && listingDecision !== 'too-large';
  const shouldFetchBlob = enabled && !!file && rendersBlob && listingDecision !== 'too-large';

  const {
    data: textContent,
    isLoading: isLoadingText,
    error: textError,
    refetch: refetchText,
  } = useOpenCodeFileContent(
    shouldFetchText ? sandboxUrl : undefined,
    shouldFetchText ? file?.path : undefined
  );

  const {
    data: blob,
    isLoading: isLoadingBlob,
    error: blobError,
    refetch: refetchBlob,
  } = useOpenCodeFileBlob(
    shouldFetchBlob ? sandboxUrl : undefined,
    shouldFetchBlob ? file?.path : undefined
  );

  // The listing may not report a size; the fetched blob always does.
  const blobTooLarge = !!blob && previewDecision({ size: blob.size, previewType }) === 'too-large';

  useEffect(() => {
    let cancelled = false;
    if (blob && file?.path && !blobTooLarge) {
      blobToDataURL(blob, file.path).then((url) => {
        if (!cancelled) setBlobUrl(url);
      });
    } else {
      setBlobUrl(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [blob, file?.path, blobTooLarge]);

  return {
    previewType,
    isBinaryFile,
    shouldFetchText,
    textContent,
    textError,
    blob,
    blobError,
    blobTooLarge,
    blobUrl,
    isLoading: isLoadingText || isLoadingBlob,
    /** Loads again after a failure (a sandbox that was asleep). */
    retry: () => {
      if (shouldFetchText) void refetchText();
      if (shouldFetchBlob) void refetchBlob();
    },
    error: textError || blobError,
    /** The size `FilePreview` checks against the preview limits. */
    size: blob?.size ?? file?.size,
  };
}
