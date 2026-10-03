'use client';

import type { CaptureFrame, CaptureFrameDetail } from '@kortix/sdk';
import { useEffect, useRef } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The screen at the moment: the frame's video chunk (a 5-minute signed URL),
 * paused at the frame's offset. Without a video (encrypted on the device, no
 * object, or no frame in the window) it shows why, plus the frame's app and
 * window so the moment still reads.
 */
export function FrameViewer({
  frame,
  detail,
  loading,
}: {
  frame: CaptureFrame | null;
  detail: CaptureFrameDetail | undefined;
  loading: boolean;
}) {
  const t = useTranslations('capture.timeline');
  const videoRef = useRef<HTMLVideoElement>(null);
  const video = detail?.video ?? null;
  // The Kortix Capture format encodes a chunk at 1 fps with frame i at i seconds,
  // so the frame index is the seek position; `offset_ms` (wall time) is the fallback.
  const index = detail?.frame.frame_index ?? frame?.frame_index ?? null;
  const offset = index !== null ? index : (video?.offset_ms ?? 0) / 1000;

  // Seek whenever the moment moves inside the same chunk, and once the metadata of a new chunk loads.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !video) return;
    const seek = () => {
      if (Math.abs(element.currentTime - offset) > 0.25) element.currentTime = offset;
    };
    if (element.readyState >= 1) seek();
    element.addEventListener('loadedmetadata', seek);
    return () => element.removeEventListener('loadedmetadata', seek);
  }, [video, offset]);

  if (loading && !detail) return <Skeleton className="aspect-video w-full rounded-md" />;

  const reason = !frame
    ? t('frame.none')
    : video?.encrypted
      ? t('frame.encrypted')
      : !video
        ? t('frame.noVideo')
        : null;

  return (
    <div className="bg-muted relative aspect-video w-full overflow-hidden rounded-md border">
      {video && !video.encrypted ? (
        <video
          ref={videoRef}
          key={video.url.split('?')[0]}
          src={video.url}
          muted
          playsInline
          preload="auto"
          aria-label={t('frame.label', { app: frame?.app ?? t('unknownApp') })}
          className="size-full object-contain"
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1.5 px-6 text-center">
          {frame ? (
            <p className="text-foreground text-sm font-medium">
              {[frame.app, frame.title].filter(Boolean).join(' — ') || t('unknownApp')}
            </p>
          ) : null}
          <p className="text-muted-foreground max-w-sm text-xs text-pretty">{reason}</p>
        </div>
      )}
    </div>
  );
}
