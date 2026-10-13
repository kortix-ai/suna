'use client';

import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { sessionLogShowGroupCall, type ToolCallBlock } from '@kortix/sdk';
import { memo, useMemo } from 'react';

/**
 * A run of consecutive `show` calls as ONE card: `sessionLogShowGroupCall`
 * merges them into one call whose input is an `items` carousel, rendered
 * through the ordinary `ToolPartRenderer` → `ShowTool` path. N single calls and
 * one N-item call render the same card.
 *
 * The merged call keeps the FIRST call's `id` and `call_id`. The segment that
 * was a lone `show` a moment ago renders under the same key, so the card is
 * not re-mounted when the next call joins it, and "Open" still targets a real
 * call.
 */
function ShowGroupRendererImpl({
  calls,
  sessionId,
  disableNavigation,
}: {
  calls: ToolCallBlock[];
  sessionId?: string;
  disableNavigation?: boolean;
}) {
  const merged = useMemo(() => sessionLogShowGroupCall(calls), [calls]);
  return <ToolPartRenderer call={merged} sessionId={sessionId} disableNavigation={disableNavigation} />;
}

export const ShowGroupRenderer = memo(ShowGroupRendererImpl);
ShowGroupRenderer.displayName = 'ShowGroupRenderer';
