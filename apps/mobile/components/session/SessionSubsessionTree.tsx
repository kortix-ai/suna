/**
 * runtime sub-sessions in the session lists (web parity:
 * `apps/web/src/features/workspace/project-sidebar/project-session-list.tsx`,
 * `ProjectSubsessionRow` + `SubAgentConnector`).
 *
 * - `SubsessionCountBadge`: the count after a session title — how many direct
 *   sub-sessions its root runtime session has (`directSubsessions`). Shown
 *   only above 4 (`showSubsessionCountBadge`; owner, 2026-09-26).
 * - `SubsessionTree`: a session's direct sub-sessions, one row each under
 *   its row: a connector (a vertical trunk plus one rounded elbow per row,
 *   `border-border` strokes) in the space under the parent's status mark,
 *   then the title (one line), starting on the parent title's left edge;
 *   optionally the relative time at the right (`shortRelative`; the Sessions
 *   page, not the drawer). Every row with sub-sessions renders it, in the
 *   drawer and on the Sessions page (owner, 2026-09-26; web shows it for the
 *   open session only). It shows the first `SUBSESSION_TREE_CAP` rows; a
 *   "Show N more" row under them shows the rest in place. A tree whose
 *   active row is past the cap shows every row, so the open sub-session is
 *   never hidden. `SubsessionTreeMemory` keeps the expanded trees of one
 *   list, so a row that virtualisation unmounts comes back expanded.
 *
 * Layout: apps/mobile/design.md → Project sidebar → Sub-sessions.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
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
export const CONNECTOR_RUN = 14;
/** Stroke of the trunk and the elbows (web: `border-2`). */
export const CONNECTOR_STROKE = 2;
/**
 * Right inset of the tree: with a row's `px-3` (12) the time ends 16pt from
 * the edge, on the same line as the parent row's content (`px-4`).
 */
const TREE_END_INSET = 4;
/** Rows a tree shows before its "Show N more" row. */
export const SUBSESSION_TREE_CAP = 5;

/** Parent session ids whose tree shows every row, for one list. */
const ExpandedTreesContext = React.createContext<Set<string> | null>(null);

/**
 * Remembers which trees of one list the user expanded, by parent session id,
 * for as long as the list is mounted. Wrap a virtualised list with it: a row
 * scrolled out of the render window unmounts, and its tree reads this set
 * when it mounts again. Without it a tree keeps its own state only.
 */
export function SubsessionTreeMemory({ children }: { children: React.ReactNode }) {
  // A mutable set, never replaced: a write re-renders nothing.
  const [expanded] = React.useState(() => new Set<string>());
  return <ExpandedTreesContext.Provider value={expanded}>{children}</ExpandedTreesContext.Provider>;
}

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
  // Same shape as the drawer's Review count pill (`CountPill`): rounded-sm
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

function SubsessionRow({
  child,
  parentTitle,
  active,
  now,
  textInset,
  onPress,
}: {
  child: ProjectRuntimeSession;
  parentTitle: string;
  active: boolean;
  /** The clock for the relative time; no time without it. */
  now?: number;
  /** Left padding of the row box, so the title starts on the parent title's edge. */
  textInset: number;
  onPress: (childId: string) => void;
}) {
  const title = subsessionTitle(child);
  const relative = now !== undefined && child.updated_at ? shortRelative(child.updated_at, now) : '';
  const spoken = relative && child.updated_at && now !== undefined ? `, ${spokenRelative(child.updated_at, now)}` : '';
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
  /** The parent project session's id: the key `SubsessionTreeMemory` remembers. */
  parentId: string;
  /** `directSubsessions(parent)`, already ordered. Renders nothing when empty. */
  subsessions: readonly ProjectRuntimeSession[];
  /** The parent session's display title, for each row's accessibility label. */
  parentTitle: string;
  /** The runtime session id the thread shows: its row is `bg-accent`. */
  activeRuntimeId: string | null;
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
  /**
   * The list's clock: each row shows its relative time at the right (Sessions
   * page). The drawer passes none and shows the title only.
   */
  now?: number;
  onPressSubsession: (childId: string) => void;
}

export function SubsessionTree({
  parentId,
  subsessions,
  parentTitle,
  activeRuntimeId,
  trunkX,
  textX,
  now,
  onPressSubsession,
}: SubsessionTreeProps) {
  const { t } = useTranslation();
  // Collapsed to the cap until "Show N more" is tapped. The list's memory
  // (`SubsessionTreeMemory`) keeps the choice across a remount.
  const remembered = React.useContext(ExpandedTreesContext);
  const [showAll, setShowAll] = React.useState(() => remembered?.has(parentId) ?? false);
  if (subsessions.length === 0) return null;
  // The open sub-session's row always shows: past the cap, the tree shows every row.
  const activeIndex = activeRuntimeId ? subsessions.findIndex((child) => child.id === activeRuntimeId) : -1;
  const expandAll = showAll || activeIndex >= SUBSESSION_TREE_CAP;
  const hiddenCount = expandAll ? 0 : Math.max(0, subsessions.length - SUBSESSION_TREE_CAP);
  const shown = hiddenCount > 0 ? subsessions.slice(0, SUBSESSION_TREE_CAP) : subsessions;
  // The "Show N more" row joins the tree like one more row.
  const rowCount = shown.length + (hiddenCount > 0 ? 1 : 0);
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
      {rowCount > 1 ? (
        <View
          pointerEvents="none"
          className="absolute border-border"
          style={{
            top: 0,
            left: strokeLeft,
            height: (rowCount - 1) * SUBSESSION_ROW_HEIGHT,
            borderLeftWidth: CONNECTOR_STROKE,
          }}
        />
      ) : null}
      {shown.map((child) => (
        <View key={child.id} style={{ height: SUBSESSION_ROW_HEIGHT }}>
          <Elbow strokeLeft={strokeLeft} />
          <SubsessionRow
            child={child}
            parentTitle={parentTitle}
            active={child.id === activeRuntimeId}
            now={now}
            textInset={textInset}
            onPress={onPressSubsession}
          />
        </View>
      ))}
      {hiddenCount > 0 ? (
        <View style={{ height: SUBSESSION_ROW_HEIGHT }}>
          <Elbow strokeLeft={strokeLeft} />
          <Pressable
            onPress={() => {
              haptics.tap();
              remembered?.add(parentId);
              setShowAll(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('sessions.showMoreSubsessionsLabel', {
              count: hiddenCount,
              title: parentTitle,
              defaultValue_one: 'Show {{count}} more sub-session of {{title}}',
              defaultValue_other: 'Show {{count}} more sub-sessions of {{title}}',
            })}
            style={{ height: SUBSESSION_ROW_HEIGHT, marginLeft: CONNECTOR_RUN, paddingLeft: textInset }}
            className="flex-row items-center rounded-xl pr-3 active:bg-foreground/5">
            <Text variant="muted" numberOfLines={1}>
              {t('sessions.showMoreSubsessions', {
                count: hiddenCount,
                defaultValue_one: 'Show {{count}} more',
                defaultValue_other: 'Show {{count}} more',
              })}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Elbow: down from the row's top, curving right into its middle. */
function Elbow({ strokeLeft }: { strokeLeft: number }) {
  return (
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
  );
}
