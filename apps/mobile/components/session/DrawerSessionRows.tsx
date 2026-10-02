import React, { useCallback, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { CONNECTOR_RUN, CONNECTOR_STROKE, SubsessionCountBadge, SubsessionTree, subsessionCountLabel } from '@/components/session/SessionSubsessionTree';
import { ExpandControl, StarterLabel } from '@/components/session/SessionTreeParts';
import type { ProjectSession } from '@/lib/projects/projects-client';
import { directSubsessions } from '@kortix/sdk';
import { sessionDisplayStatus, sessionDisplayTitle, sessionStatusLabel } from '@/lib/session/session-list';
import { childCountOf, type SessionStarter } from '@/lib/session/session-tree';
import type { SessionNeedsYou } from '@/lib/session/needs-you';
import { cn } from '@/lib/utils/index';

// ─── Session row ─────────────────────────────────────────────────────────────

/**
 * Sub-agent connector geometry, from the row's column edge. The trunk runs
 * down the centre of the coordinator's status mark: `px-4` (16) + half the
 * 20pt mark slot (10). A sub-agent row indents so its own status mark starts
 * one elbow (`CONNECTOR_RUN`) plus a 4pt gap past the trunk, as on web.
 */
const SUB_AGENT_TRUNK_X = 16 + 10;
export const NESTED_SESSION_INDENT = SUB_AGENT_TRUNK_X + CONNECTOR_RUN + 4 - 16;

function ProjectSessionListItem({
  item,
  active,
  nested = false,
  subsessionCount = 0,
  needsYou,
  starter,
  childCount = 0,
  expanded = false,
  onToggleChildren,
  onPress,
  onLongPress,
}: {
  item: ProjectSession;
  /** Who started the run, under the title: shown in Shared and Automated only
   *  (in Sessions every row is the viewer's). */
  starter?: SessionStarter;
  /** Visible sub-agent sessions (`child_count`): a count and a caret toggle them. */
  childCount?: number;
  expanded?: boolean;
  onToggleChildren?: () => void;
  /** What the session waits on (the Needs you group): a `needs-you` mark and a
   *  one-line reason under the title. */
  needsYou?: SessionNeedsYou;
  /** The session on screen: `bg-accent` at rest and the `selected` state. */
  active: boolean;
  /** A sub-agent session, rendered indented under its coordinator with an
   *  elbow into its status mark. */
  nested?: boolean;
  /** Direct runtime sub-sessions: a count badge after the title when > 0. */
  subsessionCount?: number;
  onPress: (s: ProjectSession) => void;
  /** Opens the session actions sheet (Rename, Share, Restart, Stop, Delete). */
  onLongPress: (s: ProjectSession) => void;
}) {
  const title = sessionDisplayTitle(item);
  const status = sessionDisplayStatus(item, needsYou?.count ?? 0);
  const statusLabel = [
    sessionStatusLabel(status),
    needsYou?.reason,
    subsessionCount > 0 ? subsessionCountLabel(subsessionCount) : null,
    starter ? `started by ${starter.label}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      accessibilityRole="button"
      accessibilityLabel={
        nested ? `${title}, sub-agent session, ${statusLabel}` : `${title}, ${statusLabel}`
      }
      accessibilityHint="Long press for session actions"
      accessibilityState={{ selected: active }}
      style={nested ? { marginLeft: NESTED_SESSION_INDENT } : undefined}
      className={cn(
        'flex-row items-center gap-3 rounded-xl active:bg-foreground/5',
        'px-4 py-2',
        active && 'bg-accent'
      )}>
      {nested && (
        // Elbow: down from the row's top, curving right into its status mark.
        <View
          pointerEvents="none"
          className="absolute rounded-bl-md border-border"
          style={{
            top: 0,
            bottom: '50%',
            left: SUB_AGENT_TRUNK_X - NESTED_SESSION_INDENT - CONNECTOR_STROKE / 2,
            width: CONNECTOR_RUN + CONNECTOR_STROKE / 2,
            borderLeftWidth: CONNECTOR_STROKE,
            borderBottomWidth: CONNECTOR_STROKE,
          }}
        />
      )}
      <SessionStatusMark status={status} />
      {needsYou || starter ? (
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1}>{title}</Text>
          {needsYou ? (
            <Text variant="muted" style={{ fontSize: 13, lineHeight: 17 }} numberOfLines={1}>
              {needsYou.reason}
            </Text>
          ) : starter ? (
            <StarterLabel starter={starter} />
          ) : null}
        </View>
      ) : (
        <Text className="flex-1" numberOfLines={1}>
          {title}
        </Text>
      )}
      <SubsessionCountBadge count={subsessionCount} />
      {childCount > 0 && onToggleChildren ? (
        <ExpandControl count={childCount} expanded={expanded} onToggle={onToggleChildren} title={title} />
      ) : null}
    </Pressable>
  );
}

/**
 * Sub-session tree geometry, from the row's column edge. The trunk runs down
 * the centre of the row's status mark: `px-4` (16) + half the 20pt mark slot
 * (10). Each sub-session title starts on the row's title edge: `px-4` + the
 * 20pt slot + `gap-3` (12). A nested row adds its indent to both.
 */
const NESTED_LEAD = NESTED_SESSION_INDENT;
const TRUNK_X_TOP_LEVEL = 16 + 10;
const TEXT_X_TOP_LEVEL = 16 + 20 + 12;

/**
 * A session row plus its direct runtime sub-sessions under it, always
 * (web's `renderSessionNode` shows them for the open session only; the
 * owner wants them on every row, 2026-09-26). The row keeps its `bg-accent`
 * only while the thread shows its root; while a sub-session shows, that
 * sub-session's row carries it instead.
 */
export function DrawerSessionNode({
  session,
  shown,
  activeRuntimeId,
  nested = false,
  trunkBelow = false,
  needsYou,
  starter,
  expanded = false,
  onToggleChildren,
  onPress,
  onLongPress,
  onPressSubsession,
}: {
  session: ProjectSession;
  starter?: SessionStarter;
  /** The parent's children show under it (`SessionChildren`). */
  expanded?: boolean;
  onToggleChildren?: (session: ProjectSession) => void;
  /** This is the project session on screen (thread or connecting). */
  shown: boolean;
  /** The runtime session id the thread shows; null while no thread is on screen. */
  activeRuntimeId: string | null;
  nested?: boolean;
  /** A later sibling sub-agent follows: the trunk runs through this whole node. */
  trunkBelow?: boolean;
  needsYou?: SessionNeedsYou;
  onPress: (s: ProjectSession) => void;
  onLongPress: (s: ProjectSession) => void;
  onPressSubsession: (parent: ProjectSession, childId: string) => void;
}) {
  const subsessions = useMemo(() => directSubsessions(session), [session]);
  const subsessionActive = shown && subsessions.some((child) => child.id === activeRuntimeId);
  const handlePressSubsession = useCallback(
    (childId: string) => onPressSubsession(session, childId),
    [onPressSubsession, session]
  );
  return (
    <View>
      {trunkBelow ? (
        <View
          pointerEvents="none"
          className="absolute border-border"
          style={{
            top: 0,
            bottom: 0,
            left: SUB_AGENT_TRUNK_X - CONNECTOR_STROKE / 2,
            borderLeftWidth: CONNECTOR_STROKE,
          }}
        />
      ) : null}
      <ProjectSessionListItem
        item={session}
        active={shown && !subsessionActive}
        nested={nested}
        subsessionCount={subsessions.length}
        needsYou={needsYou}
        starter={starter}
        childCount={childCountOf(session)}
        expanded={expanded}
        onToggleChildren={onToggleChildren ? () => onToggleChildren(session) : undefined}
        onPress={onPress}
        onLongPress={onLongPress}
      />
      {subsessions.length > 0 ? (
        <SubsessionTree
          subsessions={subsessions}
          parentTitle={sessionDisplayTitle(session)}
          activeRuntimeId={shown ? activeRuntimeId : null}
          trunkX={TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          textX={TEXT_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          showTime={false}
          onPressSubsession={handlePressSubsession}
        />
      ) : null}
    </View>
  );
}
