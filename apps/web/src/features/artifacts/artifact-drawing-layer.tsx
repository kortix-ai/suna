'use client';

import { parseArtifactCommentMarks, type ArtifactCommentThread } from '@kortix/sdk';
import { threadDeleted } from './artifact-discussion-logic';
import { projectDrawingMark, type DrawingRect } from './artifact-drawing';
import { DrawingStrokeShape } from './artifact-drawing-canvas';

export function ArtifactDrawingLayer({
  viewport,
  regions,
  threads,
  focusedThreadId,
}: {
  viewport: { width: number; height: number; scroll: { x: number; y: number } } | null;
  regions: Readonly<Record<string, DrawingRect>>;
  threads: readonly ArtifactCommentThread[];
  focusedThreadId: string | null;
}) {
  if (!viewport) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 size-full"
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      preserveAspectRatio="none"
      aria-hidden
      data-artifact-marks
    >
      {threads.flatMap((thread) => {
        const region = regions[thread.thread_id];
        if (
          !region ||
          thread.anchor.type !== 'region' ||
          thread.outdated ||
          threadDeleted(thread) ||
          (thread.status !== 'open' && focusedThreadId !== thread.thread_id) ||
          Math.abs(thread.anchor.viewport_width - viewport.width) > 1
        )
          return [];
        const visible = {
          ...region,
          x: region.x - viewport.scroll.x,
          y: region.y - viewport.scroll.y,
        };
        return thread.comments
          .filter((comment) => !comment.deleted_at)
          .flatMap((comment) => {
            const marks = parseArtifactCommentMarks(comment.marks);
            return (
              marks?.map((mark, index) => {
                const shape = projectDrawingMark(mark, visible);
                return (
                  <DrawingStrokeShape
                    key={`${comment.comment_id}:${index}`}
                    stroke={{
                      tool: mark.tool,
                      color: mark.color,
                      points: shape.points,
                      width: shape.width,
                    }}
                  />
                );
              }) ?? []
            );
          });
      })}
    </svg>
  );
}
