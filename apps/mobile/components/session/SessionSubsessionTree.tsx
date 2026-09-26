/**
 * OpenCode sub-sessions in the session lists (web parity:
 * `apps/web/src/features/workspace/project-sidebar/project-session-list.tsx`,
 * `ProjectSubsessionRow` + `SubAgentConnector`).
 *
 * - `SubsessionCountBadge`: the count after a session title — how many direct
 *   sub-sessions its root OpenCode session has (`directSubsessions`). Shown
 *   only above 4 (`showSubsessionCountBadge`; owner, 2026-09-26).
 * - `SubsessionTree`: a session's direct sub-sessions, one row each under
 *   its row: a connector (a vertical trunk plus one rounded elbow per row,
 *   `border-border` strokes) in the space under the parent's status mark,
 *   then the title (one line), starting on the parent title's left edge;
 *   optionally the relative time at the right (`shortRelative`; the Sessions
 *   page, not the drawer). Not collapsible. Every row with sub-sessions
 *   renders it, in the drawer and on the Sessions page (owner, 2026-09-26;
 *   web shows it for the open session only).
 *
 * Layout: apps/mobile/design.md → Project sidebar → Sub-sessions.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  showSubsessionCountBadge,
  shortRelative,
  spokenRelative,
  subsessionTitle,
  type ProjectRuntimeSession,
} from '@/lib/session/session-list';
import { cn } from '@/lib/utils/index';

/** Height of one sub-session row. Fixed, so the trunk length is exact. */
export const SUBSESSION_ROW_HEIGHT = 40;
/** Horizontal reach of an elbow; the row box starts where the curve ends (web: 3.5 spacing). */
const CONNECTOR_RUN = 14;
/** Stroke of the trunk and the elbows (web: `border-2`). */
const CONNECTOR_STROKE = 2;
/**
 * Right inset of the tree: with a row's `px-3` (12) the time ends 16pt from
 * the edge, on the same line as the parent row's content (`px-4`).
 */
const TREE_END_INSET = 4;
/** Relative times re-render on this interval so they do not freeze. */
const NOW_TICK_MS = 60_000;

/** Spoken count for a parent row's accessibility label: "1 sub-session", "3 sub-sessions". */
export function subsessionCountLabel(count: number): string {
  return `${count} sub-session${count === 1 ? '' : 's'}`;
}

/**
 * The count after a session title, only above 4 sub-sessions
 * (`showSubsessionCountBadge`). Hidden from screen readers: the row label
 * speaks the count at any size.
 */
export function SubsessionCountBadge({ count }: { count: number }) {
  if (!showSubsessionCountBadge(count)) return null;
  // Same shape as the drawer's Review count pill (`ReviewCountPill`): rounded-sm
  // tag, neutral fill — blue there means "needs you", this is only a count.
  return (
    <View
      className="rounded-sm bg-foreground/10 px-1.5 py-0.5"
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <Text
        className="font-roobert-medium text-xs text-muted-foreground"
        style={{ fontVariant: ['tabular-nums'] }}>
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}

/** A minute clock for the rows' relative times. Off (no timer) when no time shows. */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

function SubsessionRow({
  child,
  parentTitle,
  active,
  now,
  showTime,
  textInset,
  onPress,
}: {
  child: ProjectRuntimeSession;
  parentTitle: string;
  active: boolean;
  now: number;
  showTime: boolean;
  /** Left padding of the row box, so the title starts on the parent title's edge. */
  textInset: number;
  onPress: (childId: string) => void;
}) {
  const title = subsessionTitle(child);
  const relative = showTime && child.updated_at ? shortRelative(child.updated_at, now) : '';
  const spoken = relative && child.updated_at ? `, ${spokenRelative(child.updated_at, now)}` : '';
  return (
    <Pressable
      onPress={() => onPress(child.id)}
      accessibilityRole="button"
      accessibilityLabel={`${title}, sub-session of ${parentTitle}${spoken}`}
      accessibilityState={{ selected: active }}
      style={{ height: SUBSESSION_ROW_HEIGHT, marginLeft: CONNECTOR_RUN, paddingLeft: textInset }}
      className={cn(
        'flex-row items-center gap-2 rounded-xl pr-3 active:bg-foreground/5',
        active && 'bg-accent'
      )}>
      <Text className="flex-1" numberOfLines={1}>
        {title}
      </Text>
      {relative ? (
        <Text variant="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {relative}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface SubsessionTreeProps {
  /** `directSubsessions(parent)`, already ordered. Renders nothing when empty. */
  subsessions: readonly ProjectRuntimeSession[];
  /** The parent session's display title, for each row's accessibility label. */
  parentTitle: string;
  /** The OpenCode id the thread shows: its row is `bg-accent`. */
  activeOpenCodeId: string | null;
  /**
   * Distance from the tree's container left edge to the centre of the parent
   * row's status mark: the trunk runs down that line.
   */
  trunkX: number;
  /**
   * Distance from the same edge to the parent row's title: each sub-session
   * title starts there. Must be at least `trunkX + 14 + 4`.
   */
  textX: number;
  /** Relative time at the row's right (Sessions page). The drawer shows the title only. */
  showTime: boolean;
  onPressSubsession: (childId: string) => void;
}

export function SubsessionTree({
  subsessions,
  parentTitle,
  activeOpenCodeId,
  trunkX,
  textX,
  showTime,
  onPressSubsession,
}: SubsessionTreeProps) {
  const now = useMinuteClock(showTime);
  if (subsessions.length === 0) return null;
  // The row box starts where the elbow ends; its padding carries the title
  // the rest of the way to the parent title's edge (8pt for every current
  // parent layout). Never below 4pt, so the pressed fill keeps a margin.
  const textInset = Math.max(4, textX - trunkX - CONNECTOR_RUN);
  // The stroke's centre sits on the trunk line.
  const strokeLeft = -CONNECTOR_STROKE / 2;
  return (
    <View style={{ marginLeft: trunkX, paddingRight: TREE_END_INSET }}>
      {/* One trunk for the whole block (separate per-row segments leave
          sub-pixel seams). It stops at the top of the last row; that row's
          elbow draws the rest and curves away. */}
      {subsessions.length > 1 ? (
        <View
          pointerEvents="none"
          className="absolute border-border"
          style={{
            top: 0,
            left: strokeLeft,
            height: (subsessions.length - 1) * SUBSESSION_ROW_HEIGHT,
            borderLeftWidth: CONNECTOR_STROKE,
          }}
        />
      ) : null}
      {subsessions.map((child) => (
        <View key={child.id} style={{ height: SUBSESSION_ROW_HEIGHT }}>
          {/* Elbow: down from the row's top, curving right into its middle. */}
          <View
            pointerEvents="none"
            className="absolute rounded-bl-md border-border"
            style={{
              top: 0,
              left: strokeLeft,
              width: CONNECTOR_RUN - strokeLeft,
              height: SUBSESSION_ROW_HEIGHT / 2 + CONNECTOR_STROKE / 2,
              borderLeftWidth: CONNECTOR_STROKE,
              borderBottomWidth: CONNECTOR_STROKE,
            }}
          />
          <SubsessionRow
            child={child}
            parentTitle={parentTitle}
            active={child.id === activeOpenCodeId}
            now={now}
            showTime={showTime}
            textInset={textInset}
            onPress={onPressSubsession}
          />
        </View>
      ))}
    </View>
  );
}
