'use client';

import {
  getCaptureFrame,
  getCaptureVideoUrl,
  searchCapture,
  type CaptureSearchItem,
} from '@kortix/sdk';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { captureKeys } from './use-capture';

export interface PlayerSelection {
  chunkId: string;
  /** Seconds into the chunk video; a frame's `frame_index` is its second. */
  frameIndex: number;
  /** Bounds of the chunk, from the timeline. */
  startedAt: string;
  endedAt: string;
  /** Changes on every pick so a repeat pick seeks again. */
  nonce: number;
}

/** The last frame at or before second `t`. */
export function frameAt<T extends { frame_index: number }>(frames: T[], t: number): T | null {
  let found: T | null = null;
  for (const frame of frames) {
    if (frame.frame_index <= t + 0.05) found = frame;
    else break;
  }
  return found ?? frames[0] ?? null;
}

/** Every frame of one chunk, in video order. The API pages 100 at a time. */
async function listChunkFrames(
  accountId: string,
  userId: string | undefined,
  selection: PlayerSelection,
): Promise<CaptureSearchItem[]> {
  const from = selection.startedAt;
  const to = new Date(Date.parse(selection.endedAt) + 1000).toISOString();
  const frames: CaptureSearchItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await searchCapture(accountId, {
      from,
      to,
      user_id: userId,
      limit: 100,
      cursor,
    });
    frames.push(...result.items.filter((item) => item.chunk_id === selection.chunkId));
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return frames.sort((a, b) => a.frame_index - b.frame_index);
}

export function ChunkPlayer({
  accountId,
  userId,
  selection,
}: {
  accountId: string;
  /** Another member's id while an admin views their captures; otherwise undefined. */
  userId: string | undefined;
  selection: PlayerSelection;
}) {
  const t = useTranslations('capture');
  const locale = useLocale();
  const ref = useRef<HTMLVideoElement>(null);
  const pending = useRef<number | null>(selection.frameIndex);
  const [time, setTime] = useState(selection.frameIndex);

  const video = useQuery({
    queryKey: ['capture', 'video', accountId, selection.chunkId],
    queryFn: () => getCaptureVideoUrl(accountId, selection.chunkId),
    staleTime: 8 * 60_000,
  });
  const frames = useQuery({
    queryKey: captureKeys.frames(accountId, userId ?? 'me', selection.chunkId),
    queryFn: () => listChunkFrames(accountId, userId, selection),
    staleTime: 60_000,
  });
  const list = frames.data ?? [];
  const current = frameAt(list, time);
  const detail = useQuery({
    queryKey: ['capture', 'frame', accountId, current?.frame_id],
    queryFn: () => getCaptureFrame(accountId, current!.frame_id),
    enabled: !!current,
    staleTime: 60_000,
  });

  // Moves the loaded video. Before its metadata arrives the target waits in `pending`.
  const seekVideo = useCallback((seconds: number) => {
    const el = ref.current;
    if (el && el.readyState >= 1) el.currentTime = seconds;
    else pending.current = seconds;
  }, []);

  // A new pick, also inside the same chunk, moves the frame and the video.
  const [pickedNonce, setPickedNonce] = useState(selection.nonce);
  if (pickedNonce !== selection.nonce) {
    setPickedNonce(selection.nonce);
    setTime(selection.frameIndex);
  }
  useEffect(() => {
    seekVideo(selection.frameIndex);
  }, [selection.nonce, selection.frameIndex, seekVideo]);

  const index = current ? list.indexOf(current) : -1;
  const step = (delta: number) => {
    const next = list[index + delta];
    if (!next) return;
    setTime(next.frame_index);
    seekVideo(next.frame_index);
  };

  return (
    <div className="space-y-3" data-testid="capture-player">
      <div className="bg-muted border-border aspect-video overflow-hidden rounded-md border">
        {video.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loading className="size-5" />
          </div>
        ) : video.data ? (
          <video
            key={`${selection.chunkId}:${video.data.url}`}
            ref={ref}
            src={video.data.url}
            controls
            muted
            playsInline
            preload="auto"
            className="size-full object-contain"
            onLoadedMetadata={(e) => {
              if (pending.current !== null) {
                e.currentTarget.currentTime = pending.current;
                pending.current = null;
              }
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          />
        ) : (
          <p className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-sm">
            {t('videoFailed')}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('prevFrame')}
          disabled={index <= 0}
          onClick={() => step(-1)}
        >
          <CaretLeftIcon className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('nextFrame')}
          disabled={index < 0 || index >= list.length - 1}
          onClick={() => step(1)}
        >
          <CaretRightIcon className="size-4" />
        </Button>
        <span className="text-muted-foreground text-xs" data-testid="capture-frame-position">
          {current
            ? t('framePosition', { index: index + 1, count: list.length })
            : frames.isLoading
              ? ''
              : t('noFrames')}
        </span>
      </div>

      {current ? (
        <div className="space-y-1.5 text-sm" data-testid="capture-frame">
          <p className="text-foreground font-medium">
            {current.window_title || current.app_name || t('untitled')}
          </p>
          <p className="text-muted-foreground text-xs">
            {[
              new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
                new Date(current.ts),
              ),
              current.app_name,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {current.url ? (
            <p className="text-muted-foreground truncate text-xs">{current.url}</p>
          ) : null}
          <pre className="bg-muted text-foreground max-h-48 overflow-auto rounded-md p-3 text-xs break-words whitespace-pre-wrap">
            {detail.data?.text || (detail.isLoading ? '' : t('noText'))}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
