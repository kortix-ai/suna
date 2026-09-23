/**
 * One burst — a maximal run of non-text parts (`segmentTurn` kind `burst`).
 *
 * The summary line matches apps/web `turn/activity-burst.tsx`:
 * `text-sm text-muted-foreground/70`, `gap-2`, the SDK's `burstSummaryLabel`
 * ("Working · N steps" as a muted shimmer, "Completed N steps", "Completed X of
 * N steps · F failed", "N steps failed"), trailing caret
 * `size-3.5 text-muted-foreground/40`.
 *
 * Mobile departs from web on purpose: the burst never expands inline. Tapping
 * the summary line opens the activity sheet (`useActivitySheetStore`, shown by
 * `ActivitySheetHost`), a timeline of every step with a detail view per step.
 * While this row owns the open sheet it republishes its live view to the store.
 *
 * - every burst is this line, even ONE thought or ONE call ("Completed 1
 *   step"): web shows those bare, mobile never expands a step inline
 *   (Jay, 2026-09-24);
 * - a burst that merges to nothing (plumbing only) renders nothing.
 */

import { memo, useCallback, useEffect, useMemo } from 'react';
import { Pressable } from 'react-native';
import type { Part } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { CaretRightIcon } from '@/lib/icons';
import { burstView, samePartsList } from '@/lib/session/activity';
import { ownsBurst } from '@/lib/session/activity-sheet';
import { useActivitySheetStore } from '@/lib/session/activity-sheet-store';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';
import type { ActivityContextValue } from './activity-step';

// ─── Burst ───────────────────────────────────────────────────────────────────

export interface ActivityBurstProps {
  segment: { kind: 'burst'; parts: Part[] };
  /** The owning turn is still working (web `working`). */
  turnLive: boolean;
  /** Last segment in the turn — stays running across SSE gaps between tool calls. */
  isTrailing?: boolean;
  sessionId?: string;
  onOpenFile?: (path: string) => void;
  toDisplayPath?: (path: string) => string;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

function ActivityBurstImpl({
  segment,
  turnLive,
  isTrailing = false,
  sessionId,
  onOpenFile,
  toDisplayPath,
  onPermissionReply,
}: ActivityBurstProps) {
  const palette = useTurnPalette();
  const { parts } = segment;
  const view = useMemo(() => burstView(parts, turnLive, isTrailing), [parts, turnLive, isTrailing]);
  const ownsSheet = useActivitySheetStore((state) => state.sheet !== null && ownsBurst(state.sheet.partIds, parts));

  const context = useMemo<ActivityContextValue>(
    () => ({ sessionId, turnLive, onOpenFile, toDisplayPath, onPermissionReply }),
    [sessionId, turnLive, onOpenFile, toDisplayPath, onPermissionReply],
  );

  useEffect(() => {
    if (ownsSheet) useActivitySheetStore.getState().sync(parts, view, context);
  }, [ownsSheet, parts, view, context]);

  const openSheet = useCallback(() => useActivitySheetStore.getState().show(parts, view, context), [parts, view, context]);

  if (view.hidden) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the activity"
      onPress={openSheet}
      style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}
    >
      {view.running ? (
        <TextShimmer variant="muted" tone="muted" style={[TURN_TYPE.sm, TABULAR]} numberOfLines={1}>
          {view.title}
        </TextShimmer>
      ) : (
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, TABULAR, { flexShrink: 1, color: palette.muted70 }]}>
          {view.title}
        </Text>
      )}
      <CaretRightIcon size={TURN_SPACE.caret} color={palette.muted40} />
    </Pressable>
  );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };

/** `segment.parts` is a fresh array per frame while a turn streams — compare element-wise. */
export const ActivityBurst = memo(
  ActivityBurstImpl,
  (a, b) =>
    a.turnLive === b.turnLive &&
    a.isTrailing === b.isTrailing &&
    a.sessionId === b.sessionId &&
    a.onOpenFile === b.onOpenFile &&
    a.toDisplayPath === b.toDisplayPath &&
    a.onPermissionReply === b.onPermissionReply &&
    samePartsList(a.segment.parts, b.segment.parts),
);
ActivityBurst.displayName = 'ActivityBurst';
