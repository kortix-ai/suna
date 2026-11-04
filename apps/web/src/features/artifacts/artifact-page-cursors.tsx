'use client';

import type { ArtifactLiveParticipant } from '@kortix/sdk';
import type { ArtifactAnnotationViewport } from '@kortix/shared/artifact-annotations';
import { cn } from '@kortix/ui';

import { LIVE_BORDER, LIVE_TEXT } from './artifact-live-colors';
import type { ArtifactAnnotationPagePoint } from './use-artifact-annotations';

/**
 * The others' pointers on an HTML page, drawn by the parent in a layer above
 * the frame: an arrow in the person's color and their name. The page never
 * hears where anyone else is. Each viewer finds the element by its selector
 * in its own layout, so a pointer lands on the same element at any width. A
 * pointer outside this viewer's viewport is not drawn.
 */
export function ArtifactPageCursors({
  peers,
  viewport,
  pagePoint,
}: {
  peers: readonly ArtifactLiveParticipant[];
  viewport: ArtifactAnnotationViewport | null;
  pagePoint: (point: ArtifactAnnotationPagePoint) => { x: number; y: number } | null;
}) {
  if (!viewport) return null;
  const cursors = peers.flatMap((peer) => {
    if (peer.cursor?.kind !== 'page') return [];
    const at = pagePoint(peer.cursor);
    if (!at || at.x < 0 || at.y < 0 || at.x > viewport.width || at.y > viewport.height) return [];
    return [{ peer, at }];
  });
  if (!cursors.length) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-live-page-cursors
    >
      {cursors.map(({ peer, at }) => (
        <div
          key={peer.id}
          data-live-cursor={peer.id}
          // Frames arrive about 5 times a second: a 100 ms glide joins them into one motion.
          className="duration-fast absolute top-0 left-0 transition-transform ease-out motion-reduce:transition-none"
          style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
        >
          <svg
            viewBox="0 0 16 16"
            className={cn('stroke-background size-4 overflow-visible', LIVE_TEXT[peer.color])}
          >
            <path
              d="M1.5 1.5 L1.5 13 L5 9.75 L7.4 15 L9.6 14 L7.25 8.85 L12 8.5 Z"
              fill="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className={cn(
              'bg-popover text-foreground absolute top-4 left-3 max-w-48 truncate rounded-sm border-l-2 px-1.5 text-xs leading-5 font-medium whitespace-nowrap shadow-md',
              LIVE_BORDER[peer.color],
            )}
          >
            {peer.name}
          </span>
        </div>
      ))}
    </div>
  );
}
