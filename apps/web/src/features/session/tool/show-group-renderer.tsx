'use client';

import type { ShowCarouselItem } from '@/features/file-renderers/show-content-renderer';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import type { ToolPart } from '@/ui';
import { type ShowGroupItem, showGroupItems } from '@kortix/sdk';
import { memo, useMemo } from 'react';

/** A failed call keeps its slot and renders through the `error` branch of
 *  `ShowContentRenderer`, which needs the message in `content`. */
function toCarouselItem(item: ShowGroupItem): ShowCarouselItem {
  const { callID: _callID, error, ...rest } = item;
  if (item.status === 'error') {
    return { ...rest, type: 'error', content: error || 'This output failed to load.' };
  }
  return rest;
}

/**
 * Merge a run of consecutive `show` calls into ONE part whose input is an
 * `items` carousel, then render it through the ordinary `ToolPartRenderer` →
 * `ShowTool` path. N single calls and one N-item call render the same card.
 *
 * The merged part keeps the FIRST call's `id` and `callID`. The segment that
 * was a lone `show` a moment ago renders under the same key, so the card is
 * not re-mounted when the next call joins it, and "Open" still targets a real
 * call.
 */
export function mergeShowParts(parts: ToolPart[]): ToolPart {
  const first = parts[0];
  const running = parts.some((p) => p.state.status === 'running' || p.state.status === 'pending');
  const items = showGroupItems(parts).map(toCarouselItem);
  return {
    ...first,
    state: {
      ...first.state,
      status: running ? 'running' : 'completed',
      input: { items },
    },
  } as ToolPart;
}

function ShowGroupRendererImpl({
  parts,
  sessionId,
  disableNavigation,
}: {
  parts: ToolPart[];
  sessionId?: string;
  disableNavigation?: boolean;
}) {
  const merged = useMemo(() => mergeShowParts(parts), [parts]);
  return (
    <ToolPartRenderer part={merged} sessionId={sessionId} disableNavigation={disableNavigation} />
  );
}

export const ShowGroupRenderer = memo(ShowGroupRendererImpl);
ShowGroupRenderer.displayName = 'ShowGroupRenderer';
