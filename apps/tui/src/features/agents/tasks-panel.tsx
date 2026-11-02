/**
 * `/tasks`: the shared task list of the team the open session belongs to
 * (flag `agent_teams`), above the input like the other command panels.
 *
 *   ╭ Tasks · 1 of 3 done ─────────────────────────────╮
 *   │▌● #1 Write the tests                     @tester │
 *   │  ○ #2 Ship it                     blocked by #1  │
 *   │  ✓ #3 Plan                                       │
 *   ╰─────────────────── Enter peek at owner · Esc close ╯
 *
 * Read-only: the agents of the team claim and finish tasks. Enter peeks at the
 * owner's session. The team is the one the open session leads, or the one it
 * is a teammate in (`team_lead_session_id`).
 */

import { useFeatureFlag, useProjectSession, useTeamTasks } from '@kortix/sdk/react';
import { useKeyboard } from '@opentui/react';
import { useMemo, useState } from 'react';

import { printable } from '../../lib/printable.ts';
import { theme } from '../../theme.ts';
import { layoutRow, windowStart } from '../../ui/index.ts';
import { type PeekTarget, useAgentNav } from './agent-nav.tsx';
import { type TaskRow, taskRows } from './agents-model.ts';
import { matchesAgentsBinding } from './keys.ts';

export interface TasksPanelViewProps {
  rows: readonly TaskRow[];
  loading: boolean;
  width: number;
  /** Visible rows. 10 + the border fit `PICKER_RESERVE_ROWS` (12). */
  maxRows?: number;
  onPeek(target: PeekTarget): void;
  onClose(): void;
}

const GLYPH_COLOR: Record<TaskRow['status'], string> = {
  in_progress: theme.busy,
  pending: theme.faint,
  completed: theme.ok,
};

export function TasksPanelView({
  rows,
  loading,
  width,
  maxRows = 10,
  onPeek,
  onClose,
}: TasksPanelViewProps) {
  const [index, setIndex] = useState(0);
  const at = Math.min(index, Math.max(rows.length - 1, 0));
  const selected = rows[at];

  useKeyboard((key) => {
    if (matchesAgentsBinding(key, 'close')) {
      key.preventDefault();
      return onClose();
    }
    if (matchesAgentsBinding(key, 'up')) {
      key.preventDefault();
      return setIndex(Math.max(at - 1, 0));
    }
    if (matchesAgentsBinding(key, 'down')) {
      key.preventDefault();
      return setIndex(Math.min(at + 1, Math.max(rows.length - 1, 0)));
    }
    if (matchesAgentsBinding(key, 'peek')) {
      key.preventDefault();
      if (selected?.ownerSessionId)
        onPeek({ sessionId: selected.ownerSessionId, title: selected.owner.replace(/^@/, '') });
    }
  });

  const done = rows.filter((row) => row.status === 'completed').length;
  const title = loading ? 'Tasks · loading…' : `Tasks · ${done} of ${rows.length} done`;
  const hint = selected?.ownerSessionId ? 'Enter peek at owner · Esc close' : 'Esc close';
  const inner = Math.max(width - 4, 10);
  const visibleRows = Math.max(Math.min(maxRows, rows.length), 1);
  const start = windowStart(at, rows.length, visibleRows);

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={` ${title} `}
      titleColor={theme.dim}
      bottomTitle={` ${hint} `}
      bottomTitleAlignment="right"
      backgroundColor={theme.bg}
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      {rows.length === 0 ? (
        <text fg={theme.faint} wrapMode="none" height={1}>
          {loading ? ' ' : ' Tasks the team adds will show up here.'}
        </text>
      ) : (
        rows.slice(start, start + visibleRows).map((row, offset) => {
          const isSelected = start + offset === at;
          const right = [row.note, row.owner].filter(Boolean).join('  ');
          return (
            <text
              key={row.seq}
              fg={isSelected ? theme.fg : row.status === 'completed' ? theme.faint : theme.dim}
              wrapMode="none"
              height={1}
            >
              <span fg={theme.brand}>{isSelected ? '▌' : ' '}</span>
              <span fg={GLYPH_COLOR[row.status] ?? theme.faint}>{row.glyph}</span>
              {` ${layoutRow(printable(`#${row.seq} ${row.subject}`), printable(right), inner - 3)}`}
            </text>
          );
        })
      )}
    </box>
  );
}

export interface TasksPanelProps {
  projectId: string | null;
  sessionId: string | null;
  width: number;
  onClose(): void;
}

export function TasksPanel({ projectId, sessionId, width, onClose }: TasksPanelProps) {
  const nav = useAgentNav();
  const teams = useFeatureFlag(projectId, 'agent_teams').enabled;
  const session = useProjectSession(projectId ?? undefined, sessionId ?? undefined, {
    enabled: Boolean(projectId && sessionId),
  });
  const lead = session.data?.team_lead_session_id || sessionId;
  const tasks = useTeamTasks(projectId, lead, { enabled: teams });
  const rows = useMemo(() => taskRows(tasks.data), [tasks.data]);
  return (
    <TasksPanelView
      rows={rows}
      loading={tasks.isLoading}
      width={width}
      onPeek={(target) => {
        onClose();
        nav.peek(target);
      }}
      onClose={onClose}
    />
  );
}
