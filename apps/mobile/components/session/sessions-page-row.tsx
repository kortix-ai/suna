/**
 * SessionRow — one row of the Sessions page (`ProjectSessionsPage`): a
 * memoized `SettingsRow` (status mark · title · time · starter · sub-session
 * count · child caret) whose direct sub-sessions always follow under it in
 * the same tile (`SubsessionTree`). The page owns the list around it; this
 * file owns the row.
 */

import * as React from 'react';
import { View } from 'react-native';
import { directSubsessions } from '@kortix/sdk';

import { SettingsRow } from '@/components/kortix/settings-list';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import {
  CONNECTOR_STROKE,
  SubsessionCountBadge,
  SubsessionTree,
  subsessionCountLabel,
  TEXT_X_TOP_LEVEL,
  TRUNK_X_TOP_LEVEL,
} from '@/components/session/SessionSubsessionTree';
import { ExpandControl, StarterLabel } from '@/components/session/SessionTreeParts';
import type { ProjectSession } from '@/lib/projects/projects-client';
import {
  sessionDisplayStatus,
  sessionDisplayTitle,
  sessionLastActivityAt,
  sessionStatusLabel,
  shortRelative,
  showSubsessionCountBadge,
  spokenRelative,
} from '@/lib/session/session-list';
import { childCountOf, type SessionStarter } from '@/lib/session/session-tree';

interface SessionRowProps {
  session: ProjectSession;
  now: number;
  /** A sub-agent session (spawned by another session in this group, COR-162):
   *  a short connector elbow joins the status mark, indenting the label past the
   *  usual leading slot — the row's own tile stays full width. */
  nested?: boolean;
  /** Pending review-inbox items from this session (`needsYouBySession`): > 0 marks it `needs-you`. */
  needsYouCount: number;
  /** Who started the run (`initiator`), after the title. */
  starter?: SessionStarter;
  /** The parent's children show under it (KRTX-639); `undefined` = no children. */
  childRows?: React.ReactNode;
  expanded?: boolean;
  onToggleChildren?: (session: ProjectSession) => void;
  /** A row tap opens the session on its root; a sub-session row passes that sub-session's id. */
  onOpen: (session: ProjectSession, focusRuntimeId?: string) => void;
  onActions: (session: ProjectSession) => void;
}

/** A nested row's leading adds the 12pt elbow and its `gap-1.5` (6) before the mark to both edges. */
const NESTED_LEAD = 12 + 6;

/**
 * One `SettingsRow`: status mark · title · time (· sub-session count). No
 * chevron: the time holds the right edge. The session's sub-sessions follow
 * under it in the same tile (`SubsessionTree`), always.
 */
export const SessionRow = React.memo(function SessionRow({
  session,
  now,
  nested = false,
  needsYouCount,
  starter,
  childRows,
  expanded = false,
  onToggleChildren,
  onOpen,
  onActions,
}: SessionRowProps) {
  const childCount = childCountOf(session);
  const title = sessionDisplayTitle(session);
  const status = sessionDisplayStatus(session, needsYouCount);
  const lastActivity = sessionLastActivityAt(session);
  const subsessions = React.useMemo(() => directSubsessions(session), [session]);
  const subsessionCount = subsessions.length;
  const openSubsession = React.useCallback(
    (childId: string) => onOpen(session, childId),
    [onOpen, session]
  );
  const accessibilityLabel = [
    title,
    nested ? 'sub-agent session' : null,
    sessionStatusLabel(status),
    spokenRelative(lastActivity, now),
    subsessionCount > 0 ? subsessionCountLabel(subsessionCount) : null,
    starter ? `started by ${starter.label}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const row = (
    <SettingsRow
      leading={
        nested ? (
          <View className="flex-row items-center gap-1.5">
            {/* Each row is its own tile, so no trunk can join the tiles: a
                short elbow in the connector stroke (`SubsessionTree`) marks
                the sub-agent instead of an icon. */}
            <View
              className="rounded-bl-md border-border"
              style={{
                width: 12,
                height: 10,
                marginTop: -10,
                borderLeftWidth: CONNECTOR_STROKE,
                borderBottomWidth: CONNECTOR_STROKE,
              }}
            />
            <SessionStatusMark status={status} />
          </View>
        ) : (
          <SessionStatusMark status={status} />
        )
      }
      label={title}
      value={shortRelative(lastActivity, now)}
      labelAccessory={
        starter || showSubsessionCountBadge(subsessionCount) ? (
          <View className="flex-row items-center gap-2">
            {starter ? <StarterLabel starter={starter} /> : null}
            {showSubsessionCountBadge(subsessionCount) ? <SubsessionCountBadge count={subsessionCount} /> : null}
          </View>
        ) : undefined
      }
      right={
        childCount > 0 && onToggleChildren ? (
          <ExpandControl
            count={childCount}
            expanded={expanded}
            onToggle={() => onToggleChildren(session)}
            title={title}
          />
        ) : null
      }
      onPress={() => onOpen(session)}
      onLongPress={() => onActions(session)}
      longPressLabel="Session actions"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens the session"
    />
  );
  if (subsessionCount === 0 && !(expanded && childRows)) return row;
  return (
    <View>
      {row}
      {expanded ? childRows : null}
      {/* No thread is open while this page shows (useCoveringRoute), so no
          sub-session row is highlighted. */}
      {subsessionCount > 0 ? (
      <View className="pb-2">
        <SubsessionTree
          parentId={session.session_id}
          subsessions={subsessions}
          parentTitle={title}
          activeRuntimeId={null}
          trunkX={TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          textX={TEXT_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)}
          now={now}
          onPressSubsession={openSubsession}
        />
      </View>
      ) : null}
    </View>
  );
});
