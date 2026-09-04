'use client';

import { useTranslations } from 'next-intl';

import { useFileContent } from '@/features/files/hooks/use-file-content';
import { fetchAttachmentPart, isAttachmentPartRef, isSandboxNotReadyError } from '@kortix/sdk';
import { ImagePreview } from '@/features/session/image-preview';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';

/**
 * Detect whether a URL string is a local sandbox filesystem path
 * (e.g. /workspace/uploads/...) rather than a valid HTTP/data/blob URL.
 * Matches the pattern used in tool-renderers.tsx.
 */
function isLocalSandboxFilePath(value: string): boolean {
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return false;
  return value.startsWith('/');
}

/**
 * Resolve a raw `src` — sandbox path OR ready-made URL — to something an
 * `<img>` can load.
 *
 * Extracted from `SandboxImage` so callers that need the resolved URL for
 * something else (a lightbox, a download) can get it without also inheriting
 * SandboxImage's markup, which hardcodes an 80px minimum on its loading and
 * error states and so cannot be used at thumbnail size.
 */
function useAttachmentPartBlobUrl(src: string): { url: string | null; loading: boolean } {
  const isRef = isAttachmentPartRef(src);
  const [state, setState] = useState<{ src: string; url: string | null; loading: boolean }>({
    src: '',
    url: null,
    loading: false,
  });

  useEffect(() => {
    if (!isRef) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchAttachmentPart(src);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src, url: objectUrl, loading: false });
      } catch {
        if (!cancelled) setState({ src, url: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isRef, src]);

  if (!isRef) return { url: null, loading: false };
  return state.src === src ? { url: state.url, loading: state.loading } : { url: null, loading: true };
}

export function useSandboxImageSrc(src: string): {
  resolvedSrc: string | null;
  isLoading: boolean;
} {
  const partRef = useAttachmentPartBlobUrl(src);
  // A part reference is a daemon path, so it must be answered before the
  // workspace-path branch below claims it.
  const isLocalPath = !isAttachmentPartRef(src) && isLocalSandboxFilePath(src);

  // Strip /workspace/ prefix since the SDK expects paths relative to project root
  const fileContentPath = useMemo(() => {
    if (!isLocalPath) return null;
    return src.replace(/^\/workspace\//, '');
  }, [isLocalPath, src]);

  const {
    data: fileContentData,
    isLoading,
    error,
  } = useFileContent(fileContentPath, {
    enabled: !!fileContentPath,
  });

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const hasBase64 = fileContentData?.encoding === 'base64' && !!fileContentData?.content;

  useEffect(() => {
    if (!(fileContentData?.encoding === 'base64' && fileContentData.content)) {
      setBlobUrl(null);
      return;
    }
    const binary = atob(fileContentData.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: fileContentData.mimeType || 'image/png' });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [fileContentData]);

  if (isAttachmentPartRef(src)) {
    return { resolvedSrc: partRef.url, isLoading: partRef.loading };
  }

  return {
    resolvedSrc: isLocalPath ? blobUrl : src,
    // A readiness 503 (parked/booting sandbox) counts as loading, not failure:
    // useFileContent keeps polling while it lasts, so the image resolves on
    // its own once the box is up — meanwhile show the skeleton, never the
    // "Image unavailable" box.
    isLoading:
      isLocalPath && (isLoading || (hasBase64 && !blobUrl) || isSandboxNotReadyError(error)),
  };
}

interface SandboxImageProps {
  /** Raw src — may be a sandbox filesystem path or a valid URL */
  src: string;
  alt?: string;
  className?: string;
  /** When true, wraps the image in an ImagePreview dialog for full-size viewing */
  preview?: boolean;
}

/**
 * SandboxImage — renders an image that may reference a sandbox filesystem path.
 *
 * If `src` is a local sandbox path (e.g. /workspace/uploads/...), fetches the
 * file content via the OpenCode SDK (useFileContent), converts base64 to a blob
 * URL, and renders that. If `src` is already a valid HTTP/data/blob URL, renders
 * it directly.
 *
 * Follows the same pattern as tool-renderers.tsx ImageGenTool (lines 3660-3685).
 */
export function SandboxImage({ src, alt = 'Image', className, preview }: SandboxImageProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isLocalPath = isLocalSandboxFilePath(src);
  const { resolvedSrc, isLoading } = useSandboxImageSrc(src);

  // Loading state — show skeleton while fetching from sandbox
  if (isLoading) {
    return (
      <div
        className={cn('bg-muted/40 animate-pulse rounded', className)}
        style={{ minHeight: 80, minWidth: 80 }}
      />
    );
  }

  // Error state — fetch completed but no blob URL (file not found, etc.)
  if (isLocalPath && !isLoading && !resolvedSrc) {
    return (
      <div
        className={cn(
          'bg-muted/20 text-muted-foreground flex items-center justify-center rounded text-xs',
          className,
        )}
        style={{ minHeight: 80, minWidth: 80 }}
      >
        {tHardcodedUi.raw('componentsSessionSandboxImage.line96JsxTextImageUnavailable')}
      </div>
    );
  }

  if (!resolvedSrc) return null;

  const img = (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img src={resolvedSrc} alt={alt} className={className} />
  );

  if (preview) {
    return (
      <ImagePreview src={resolvedSrc} alt={alt}>
        {img}
      </ImagePreview>
    );
  }

  return img;
}
